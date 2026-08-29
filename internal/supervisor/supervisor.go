// Package supervisor owns the local llama-server process: starting it at boot,
// restarting it when it dies, and hot-swapping the loaded GGUF on request.
//
// On Windows this logic lived in two places at once — launch.bat's monitor loop
// and fileserver.ps1's swap handler — which is exactly the drift the Go port
// exists to remove. Here it is one state machine in one process.
//
// Only local mode uses this. In remote mode llama.cpp belongs to somebody else
// and /swap-model answers 503, which is the same honest answer fileserver.ps1
// gave whenever launch.bat had not handed it a server executable.
package supervisor

import (
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/jmccardle/gobbonet/internal/models"
)

// Phase is the swap state chat.html polls for.
const (
	PhaseIdle     = "idle"
	PhaseStarting = "starting"
	PhaseReady    = "ready"
	PhaseError    = "error"
)

const (
	// swapTimeout matches the client's own 3-minute poll budget in
	// pollSwapStatus(). Going longer would leave the UI showing a failure while
	// the server still believed it was working.
	swapTimeout = 3 * time.Minute

	// portFreeTimeout bounds the wait for the old server to release the port.
	portFreeTimeout = 15 * time.Second

	// gracePeriod is how long a SIGTERM gets before SIGKILL.
	gracePeriod = 5 * time.Second

	// stderrRingSize is enough to hold llama.cpp's startup banner plus the
	// failure that follows it.
	stderrRingSize = 64 * 1024

	healthProbeInterval = 500 * time.Millisecond
)

// Tuning is the part of the llama-server command line that /perf can change
// while the server is running. Held apart from Options because Options is
// fixed at startup and this is not.
type Tuning struct {
	CtxSize     int
	GPULayers   int
	KVCacheType string
}

// Options configures a Supervisor.
type Options struct {
	ServerExe string
	ModelDir  string
	LLMURL    string
	APIKey    string
	// Tuning is the starting point. Changing it later goes through SetTuning,
	// which is what /perf calls; it takes effect on the next llama-server
	// start, i.e. the swap the client drives immediately afterwards.
	Tuning  Tuning
	LogFile string

	// ChatTemplateName / ChatTemplateFile override what the classifier picked.
	// Only set these when a model's embedded template is known-broken.
	ChatTemplateName string
	ChatTemplateFile string
}

// Status is the /swap-status payload.
type Status struct {
	Phase     string `json:"phase"`
	File      string `json:"file,omitempty"`
	Name      string `json:"name,omitempty"`
	Message   string `json:"message,omitempty"`
	StartedAt int64  `json:"started_at,omitempty"`
	UpdatedAt int64  `json:"updated_at,omitempty"`
}

// Supervisor manages one llama-server process.
type Supervisor struct {
	opts Options

	host string
	port string

	stderr *ringBuffer
	client *http.Client

	mu sync.Mutex
	// tuning is opts.Tuning as it stands now. Guarded by mu because /perf
	// rewrites it from a request goroutine while a swap may be reading it.
	tuning Tuning
	cmd    *exec.Cmd
	// pgid is the process group captured at launch. Kept separately from cmd
	// because it stays valid after the reaper has Wait()ed the child, which is
	// precisely when surviving helpers still need killing.
	pgid    int
	current string // GGUF basename currently loaded
	// previous is the last model known to have started successfully. A failed
	// swap rolls back to it rather than leaving the user with no server at all.
	previous string
	status   Status
	swapping bool
	// stopping suppresses the restart-on-exit path while we are deliberately
	// killing the process.
	stopping bool
	// exited is closed by the reaper when the current process ends.
	exited chan struct{}

	// OnReady runs after a model finishes loading, so caches keyed on model
	// identity can be dropped.
	OnReady func()
}

// New builds a Supervisor. The llm_url must point at the loopback port this
// process will bind llama-server to.
func New(opts Options) (*Supervisor, error) {
	u, err := url.Parse(opts.LLMURL)
	if err != nil {
		return nil, fmt.Errorf("llm_url %q: %w", opts.LLMURL, err)
	}
	host, port := u.Hostname(), u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}

	return &Supervisor{
		opts:   opts,
		tuning: opts.Tuning,
		host:   host,
		port:   port,
		stderr: newRingBuffer(stderrRingSize),
		client: &http.Client{Timeout: 3 * time.Second},
		status: Status{Phase: PhaseIdle},
	}, nil
}

// Tuning returns the launch arguments a restart would use right now.
func (s *Supervisor) Tuning() Tuning {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tuning
}

// SetTuning changes what the NEXT llama-server start will use. It deliberately
// does not restart anything: applying the change reuses the existing hot-swap
// path, so there stays exactly one restart mechanism in this codebase, with one
// lock and one status feed, rather than two that can race each other.
func (s *Supervisor) SetTuning(t Tuning) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tuning = t
}

// CurrentFile is the GGUF basename currently loaded, or "".
func (s *Supervisor) CurrentFile() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

// Status returns the current swap status for the polling client.
func (s *Supervisor) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Supervisor) setStatus(phase, file, name, message string, startedAt int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status = Status{
		Phase:     phase,
		File:      file,
		Name:      name,
		Message:   message,
		StartedAt: startedAt,
		UpdatedAt: time.Now().Unix(),
	}
}

// --- Command construction --------------------------------------------------

// BuildArgs assembles the llama-server command line for a model record.
//
// Mirrors the argument set launch.bat constructs in its :start_server block, and
// the one Build-LaunchScript rebuilt for a swap. Both used to exist separately
// and could disagree; here the record comes from the same classifier in both
// cases, so they cannot.
func (s *Supervisor) BuildArgs(rec models.Record, modelPath string) []string {
	useJinja := rec.UseJinja != 0
	chatTemplate := rec.ChatTemplate
	chatTemplateFile := ""

	// A sidecar template is a FILE, a built-in is a NAME, and they are not
	// interchangeable: passing a path to --chat-template makes llama-server
	// treat the path text itself as a literal template body.
	if rec.ChatTemplateFile != "" {
		abs := rec.ChatTemplateFile
		if !filepath.IsAbs(abs) {
			// Records carry "models/<name>.jinja"; resolve against the model
			// directory's parent so both that and a bare name work.
			abs = filepath.Join(s.opts.ModelDir, filepath.Base(abs))
		}
		// Re-validate at launch time, not just at classification time. A sidecar
		// can be replaced by a failed re-download between the two, and handing
		// llama-server a 15-byte "Entry not found" body makes it render the same
		// few words for every turn while the model ignores the conversation.
		if models.UsableTemplate(abs) {
			chatTemplateFile = abs
			useJinja = true
			chatTemplate = "" // clear the built-in name to prevent a collision
		} else {
			log.Printf("[swap] ignoring unusable sidecar template: %s", abs)
		}
	}

	// Explicit config overrides win over everything the classifier decided.
	if s.opts.ChatTemplateFile != "" && models.UsableTemplate(s.opts.ChatTemplateFile) {
		chatTemplateFile = s.opts.ChatTemplateFile
		useJinja = true
		chatTemplate = ""
	} else if s.opts.ChatTemplateName != "" {
		chatTemplate = s.opts.ChatTemplateName
		chatTemplateFile = ""
		useJinja = false
	}

	// The pinned llama.cpp build does NOT register "mistral-v7-tekken" as a
	// built-in name. Passed bare to --chat-template it is treated as a literal
	// template *body* and renders to a constant ~8-token string for every
	// request — the model never sees the conversation and just talks about
	// "tekken". "mistral-v7" resolves to the real C++ template; the only delta
	// is a trailing space after [INST], harmless for inference.
	//
	// Normalised unconditionally so no stale record can leak it through.
	if chatTemplate == "mistral-v7-tekken" {
		chatTemplate = "mistral-v7"
		useJinja = false
	}

	// Read the tuning once, so a /perf write landing mid-assembly cannot put
	// one model's context size next to another's KV cache type.
	tune := s.Tuning()

	args := []string{
		"--model", modelPath,
		"--port", s.port,
		"--host", s.host,
		"--ctx-size", itoaInt(tune.CtxSize),
		"--n-gpu-layers", itoaInt(tune.GPULayers),
		"--cache-type-k", tune.KVCacheType,
		"--cache-type-v", tune.KVCacheType,
		"--parallel", "1",
		"-lv", "4",
	}
	if useJinja {
		args = append(args, "--jinja")
	}
	if chatTemplateFile != "" {
		args = append(args, "--chat-template-file", chatTemplateFile)
	} else if chatTemplate != "" {
		args = append(args, "--chat-template", chatTemplate)
	}
	args = append(args, "--reasoning-format", "auto")
	if s.opts.APIKey != "" {
		args = append(args, "--api-key", s.opts.APIKey)
	}
	return args
}

func itoaInt(n int) string { return fmt.Sprintf("%d", n) }

// --- Process lifecycle -----------------------------------------------------

// start spawns llama-server for the named GGUF. It does not wait for readiness.
func (s *Supervisor) start(file string) error {
	modelPath := filepath.Join(s.opts.ModelDir, file)
	if _, err := os.Stat(modelPath); err != nil {
		return fmt.Errorf("model %s not found in %s", file, s.opts.ModelDir)
	}

	rec := models.IdentifyFile(modelPath)
	args := s.BuildArgs(rec, modelPath)

	cmd := exec.Command(s.opts.ServerExe, args...)
	configureProcessGroup(cmd)

	s.stderr.Reset()
	// Tee stderr: the ring buffer answers "why did this fail" immediately, and
	// the log file keeps the full history for anything the ring rotated past.
	var logFile *os.File
	if f, err := os.OpenFile(s.opts.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		logFile = f
		cmd.Stderr = io.MultiWriter(s.stderr, logFile)
		cmd.Stdout = logFile
	} else {
		cmd.Stderr = s.stderr
	}

	log.Printf("[swap] launching: %s %s", s.opts.ServerExe, strings.Join(args, " "))
	if err := cmd.Start(); err != nil {
		if logFile != nil {
			logFile.Close()
		}
		return fmt.Errorf("could not start llama-server: %w", err)
	}

	exited := make(chan struct{})

	s.mu.Lock()
	s.cmd = cmd
	s.pgid = processGroupID(cmd)
	s.current = file
	s.exited = exited
	s.mu.Unlock()

	// Reap the child so it never becomes a zombie, and notice unexpected exits.
	go func() {
		err := cmd.Wait()
		close(exited)
		if logFile != nil {
			logFile.Close()
		}

		s.mu.Lock()
		deliberate := s.stopping || s.swapping
		if !deliberate && s.cmd == cmd {
			// Clear the handle so the restart path can tell "no process" from
			// "a process someone else is managing".
			s.cmd = nil
		}
		s.mu.Unlock()

		if deliberate {
			return
		}
		log.Printf("[swap] llama-server exited unexpectedly: %v", err)
		s.restartAfterCrash(file)
	}()

	return nil
}

// restartAfterCrash brings llama-server back after an unplanned exit.
//
// This is launch.bat's monitor loop, moved inside the binary. Keeping it in the
// shell script meant the restart path and the swap path could disagree about how
// the server should be launched; here they call the same start().
//
// Backoff is exponential because the common cause of a crash-on-start is a
// configuration problem that will not fix itself, and hammering the GPU with
// restart attempts makes the logs unreadable without making anything better.
func (s *Supervisor) restartAfterCrash(file string) {
	backoff := time.Second
	const maxBackoff = 2 * time.Minute

	for attempt := 1; ; attempt++ {
		time.Sleep(backoff)

		s.mu.Lock()
		// A swap or a shutdown started while we were waiting; that path owns
		// the process now.
		busy := s.swapping || s.stopping || s.cmd != nil
		s.mu.Unlock()
		if busy {
			return
		}

		log.Printf("[swap] restart attempt %d for %s", attempt, file)
		if err := s.start(file); err != nil {
			log.Printf("[swap] restart failed: %v", err)
		} else if err := s.waitHealthy(time.Now().Add(swapTimeout)); err != nil {
			log.Printf("[swap] restarted process did not become healthy: %v", err)
		} else {
			log.Printf("[swap] llama-server recovered")
			s.setStatus(PhaseReady, file, file, "Ready", time.Now().Unix())
			if s.OnReady != nil {
				s.OnReady()
			}
			return
		}

		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// stop ends the running process and waits for the port to be released.
//
// The wait is not optional. Kill returns before the kernel has released the
// listening socket; spawning the replacement too early makes its bind() fail and
// it exits within milliseconds, leaving /swap-status at "starting" until the
// timeout — which looks exactly like a model that is slow to load.
func (s *Supervisor) stop() {
	s.mu.Lock()
	cmd := s.cmd
	pgid := s.pgid
	exited := s.exited
	s.stopping = true
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.stopping = false
		s.cmd = nil
		s.pgid = 0
		s.mu.Unlock()
	}()

	if cmd == nil || cmd.Process == nil {
		// No handle, but possibly still a group: the reaper clears s.cmd when the
		// process dies on its own, and that is exactly the crash case where
		// orphaned helpers are most likely to be left behind.
		s.reapGroup(pgid)
		s.waitPortFree()
		return
	}

	// Has the process we launched already gone? That is the normal case on the
	// rollback path — the model we were asked to load failed and died before we
	// got here — so its exit is not worth reporting as a failure.
	//
	// It is emphatically NOT a reason to stop here. The leader exiting says
	// nothing about the rest of its group: llama-server's helpers get reparented
	// to init and keep running, still holding VRAM. Returning early at this point
	// is what leaves the next model unable to allocate a backend buffer. Whatever
	// the leader did, the group still has to be swept.
	leaderGone := false
	select {
	case <-exited:
		leaderGone = true
	default:
	}

	if !leaderGone {
		if err := terminateGroup(pgid, false); err != nil {
			log.Printf("[swap] SIGTERM to process group failed: %v", err)
		}
		select {
		case <-exited:
		case <-time.After(gracePeriod):
			log.Printf("[swap] llama-server did not exit in %s; forcing", gracePeriod)
		}
	}

	s.reapGroup(pgid)
	s.waitPortFree()
}

// reapGroup ensures nothing from the launched process group is left running.
//
// Membership, not the leader's exit status, is the completion condition — a
// helper that ignored SIGTERM, or one orphaned when llama-server crashed, is
// invisible to cmd.Wait() and to any walk of our own descendants, but it still
// holds the GPU memory the next model needs.
func (s *Supervisor) reapGroup(pgid int) {
	if pgid <= 0 || !groupAlive(pgid) {
		return
	}

	// The leader may already have taken the polite signal; members still here
	// have either ignored it or never received one.
	if err := terminateGroup(pgid, false); err != nil {
		log.Printf("[swap] SIGTERM to process group failed: %v", err)
	}
	if waitGroupGone(pgid, gracePeriod) {
		return
	}

	log.Printf("[swap] process group %d outlived SIGTERM; forcing", pgid)
	if err := terminateGroup(pgid, true); err != nil {
		log.Printf("[swap] SIGKILL to process group failed: %v", err)
	}
	if !waitGroupGone(pgid, gracePeriod) {
		// Worth shouting about: this is the state in which a swap will fail to
		// allocate VRAM, and the cause is not something the next error message
		// will explain.
		log.Printf("[swap] WARNING: processes from group %d survived SIGKILL and may still hold GPU memory", pgid)
	}
}

// waitGroupGone polls until the group is empty or the deadline passes.
func waitGroupGone(pgid int, within time.Duration) bool {
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if !groupAlive(pgid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return !groupAlive(pgid)
}

// waitPortFree blocks until nothing accepts on the upstream port.
func (s *Supervisor) waitPortFree() {
	deadline := time.Now().Add(portFreeTimeout)
	address := net.JoinHostPort(s.host, s.port)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
		if err != nil {
			return
		}
		conn.Close()
		time.Sleep(250 * time.Millisecond)
	}
	log.Printf("[swap] port %s still bound after %s; continuing anyway", address, portFreeTimeout)
}

// waitHealthy polls the upstream's /health until it answers 200.
func (s *Supervisor) waitHealthy(deadline time.Time) error {
	for time.Now().Before(deadline) {
		s.mu.Lock()
		exited := s.exited
		s.mu.Unlock()

		// A process that has already died will never become healthy; failing
		// now turns a 3-minute wait into an immediate, accurate error.
		select {
		case <-exited:
			if msg := s.stderr.LastError(); msg != "" {
				return fmt.Errorf("%s", msg)
			}
			return fmt.Errorf("llama-server exited during startup")
		default:
		}

		resp, err := s.client.Get(s.opts.LLMURL + "/health")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(healthProbeInterval)
	}
	if msg := s.stderr.LastError(); msg != "" {
		return fmt.Errorf("%s", msg)
	}
	return fmt.Errorf("model did not respond within %s", swapTimeout)
}

// Boot starts the initial model. Picks the configured model if there is one,
// otherwise the first GGUF in the model directory.
func (s *Supervisor) Boot(preferred string) error {
	file := preferred
	if file == "" {
		records := models.ScanDir(s.opts.ModelDir)
		if len(records) == 0 {
			return fmt.Errorf("no .gguf files in %s", s.opts.ModelDir)
		}
		file = records[0].File
	}

	startedAt := time.Now().Unix()
	s.setStatus(PhaseStarting, file, file, "Loading model", startedAt)

	if err := s.start(file); err != nil {
		s.setStatus(PhaseError, file, file, err.Error(), startedAt)
		return err
	}
	if err := s.waitHealthy(time.Now().Add(swapTimeout)); err != nil {
		s.setStatus(PhaseError, file, file, err.Error(), startedAt)
		return err
	}

	s.mu.Lock()
	s.previous = file
	s.mu.Unlock()

	s.setStatus(PhaseReady, file, file, "Ready", startedAt)
	if s.OnReady != nil {
		s.OnReady()
	}
	return nil
}

// ErrSwapInFlight means a swap is already running.
var ErrSwapInFlight = fmt.Errorf("a swap is already in progress")

// Swap changes the loaded model. It returns as soon as the swap is dispatched;
// the client polls /swap-status for the outcome.
func (s *Supervisor) Swap(file string) error {
	file = filepath.Base(file)
	if !strings.HasSuffix(strings.ToLower(file), ".gguf") {
		return fmt.Errorf("model %q must be a .gguf file", file)
	}
	modelPath := filepath.Join(s.opts.ModelDir, file)
	info, err := os.Stat(modelPath)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("model %q not found in %s", file, s.opts.ModelDir)
	}

	s.mu.Lock()
	if s.swapping {
		s.mu.Unlock()
		return ErrSwapInFlight
	}
	s.swapping = true
	previous := s.current
	s.mu.Unlock()

	startedAt := time.Now().Unix()
	rec := models.IdentifyFile(modelPath)
	s.setStatus(PhaseStarting, file, rec.Name, "Stopping current model", startedAt)

	go s.runSwap(file, rec.Name, previous, startedAt)
	return nil
}

func (s *Supervisor) runSwap(file, name, previous string, startedAt int64) {
	defer func() {
		s.mu.Lock()
		s.swapping = false
		s.mu.Unlock()
	}()

	// Kill-then-start, not start-then-kill. On a single GPU there is not enough
	// VRAM to hold two models at once, so the old one must be fully gone before
	// the new one begins loading.
	s.stop()
	s.setStatus(PhaseStarting, file, name, "Loading new model", startedAt)

	if err := s.start(file); err != nil {
		s.rollback(previous, file, name, startedAt, err.Error())
		return
	}
	if err := s.waitHealthy(time.Now().Add(swapTimeout)); err != nil {
		s.rollback(previous, file, name, startedAt, err.Error())
		return
	}

	s.mu.Lock()
	s.previous = file
	s.mu.Unlock()

	log.Printf("[swap] active model is now %s", file)
	s.setStatus(PhaseReady, file, name, "Ready", startedAt)
	if s.OnReady != nil {
		s.OnReady()
	}
}

// rollback restores the previous model after a failed swap.
//
// Without this, choosing a corrupt or too-large GGUF leaves the user with no
// server at all — every subsequent request 502s and the only way back is a
// restart. Returning to the model that was working thirty seconds ago is almost
// always what they want.
func (s *Supervisor) rollback(previous, failedFile, failedName string, startedAt int64, reason string) {
	log.Printf("[swap] %s failed to load: %s", failedFile, reason)

	if previous == "" || previous == failedFile {
		s.setStatus(PhaseError, failedFile, failedName, reason, startedAt)
		return
	}

	log.Printf("[swap] rolling back to %s", previous)
	s.stop()

	if err := s.start(previous); err != nil {
		s.setStatus(PhaseError, failedFile, failedName,
			fmt.Sprintf("%s (rollback to %s also failed: %v)", reason, previous, err), startedAt)
		return
	}
	if err := s.waitHealthy(time.Now().Add(swapTimeout)); err != nil {
		s.setStatus(PhaseError, failedFile, failedName,
			fmt.Sprintf("%s (rollback to %s also failed: %v)", reason, previous, err), startedAt)
		return
	}

	if s.OnReady != nil {
		s.OnReady()
	}
	// The phase is 'error' because the swap the user asked for did not happen,
	// but the message says the server is still usable — which is the part they
	// need to know before deciding what to do next.
	s.setStatus(PhaseError, failedFile, failedName,
		fmt.Sprintf("%s — rolled back to %s, which is still running.", reason, previous), startedAt)
}

// Shutdown stops the managed process.
func (s *Supervisor) Shutdown() {
	s.mu.Lock()
	running := s.cmd != nil
	s.mu.Unlock()
	if running {
		log.Printf("[swap] stopping llama-server")
		s.stop()
	}
}
