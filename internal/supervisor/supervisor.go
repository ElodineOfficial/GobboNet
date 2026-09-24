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

	"github.com/ElodineOfficial/GobboNet/internal/models"
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
	GPUReserveMiB int
	ServerExe     string
	ModelDir      string
	LLMURL        string
	APIKey        string
	// Tuning is the starting point. Changing it later goes through SetTuning,
	// which is what /perf calls; it takes effect on the next llama-server
	// start, i.e. the swap the client drives immediately afterwards.
	Tuning Tuning
	// LoadTimeout is normally three minutes; tests can use a short deadline.
	LoadTimeout time.Duration
	// RecoveryBackoff is the first wait before restarting a crashed engine,
	// doubling to two minutes. Normally one second; tests can shorten it.
	RecoveryBackoff time.Duration
	LogFile         string

	// ConsoleOut is where the engine's own output is mirrored as it arrives.
	// nil keeps it off the screen, which is what every release up to 1.7.4 did
	// -- and the reason "loading" looked like a frozen window: llama.cpp's
	// stdout went only to LogFile and its stderr only to LogFile plus the error
	// ring, so a model taking a minute to load printed nothing at all.
	//
	// cmd/gobbonet sets this to os.Stdout unless show_engine_output is off.
	// See internal/supervisor/engineout.go.
	ConsoleOut io.Writer

	// EngineOutputFull turns the console filter off, so every line the engine
	// prints is shown. Off by default: a real session was 680 engine lines to
	// 221 of everything else, and the events people watch for -- a model
	// loaded, a hot swap, the server standing down -- were lost in it.
	//
	// The LOG FILE is never filtered, either way.
	EngineOutputFull bool

	// ChatTemplateName / ChatTemplateFile override what the classifier picked.
	// Only set these when a model's embedded template is known-broken.
	ChatTemplateName string
	ChatTemplateFile string
}

// GPUConfirmed reports that the running engine said layers reached the GPU.
//
// False is "not confirmed", not "on the CPU" -- see engineWatch.GPUConfirmed
// for why that distinction is load-bearing.
func (s *Supervisor) GPUConfirmed() bool { return s.engine.GPUConfirmed() }

// VRAMPressure reports that the engine complained about fitting the model.
func (s *Supervisor) VRAMPressure() bool { return s.engine.VRAMPressure() }

// EngineSpoke reports whether any engine output was seen at all.
func (s *Supervisor) EngineSpoke() bool { return s.engine.SawOutput() }

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

	// opMu serializes process transitions. Never acquire it while holding mu.
	opMu            sync.Mutex
	mu              sync.Mutex
	closed          bool
	shutdown        chan struct{}
	generation      uint64
	usable          bool
	memoryHelpStamp string
	memoryHelpErr   error
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

	// engine watches the output going past for the two facts a user needs out
	// of it: whether layers reached the GPU, and whether VRAM is tight. Both
	// were reported on screen by launch.bat's STEP 3b and by nothing at all on
	// this path. Reset per launch, like the stderr ring beside it.
	engine *engineWatch

	// console is the prefixing writer for the running process, kept so the
	// reaper can flush a final partial line -- the last thing a crashing engine
	// prints is usually the reason, and it often arrives without a newline.
	console *prefixWriter

	// Idle stand-down bookkeeping. See standdown.go for the whole mechanism.
	// lastUse is the last time a request reached the backend; inFlight is how
	// many are in progress right now, which is what stops a long generation
	// being mistaken for an idle one. stoodDown means the model was unloaded
	// deliberately rather than having crashed, and standFile is the model to
	// bring back. opMu ensures simultaneous requests wait for one load.
	lastUse   time.Time
	inFlight  int
	stoodDown bool
	standFile string

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
		opts:     opts,
		shutdown: make(chan struct{}),
		tuning:   opts.Tuning,
		host:     host,
		port:     port,
		stderr:   newRingBuffer(stderrRingSize),
		engine:   newEngineWatch(),
		client:   &http.Client{Timeout: 3 * time.Second},
		status:   Status{Phase: PhaseIdle},
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
// This is the ONLY builder on the Go path, so the .deb and the Windows
// installer start llama-server identically. launch.bat's :start_server block
// and Build-LaunchScript are the legacy batch/PowerShell equivalents; those two
// used to exist separately and could disagree, whereas here the record comes
// from the same classifier in both cases.
//
// It matches launch.bat flag for flag, including -lv.
//
// -lv was left off until 1.7.5, on the reasoning that launch.bat only raised
// llama.cpp's verbosity so its STEP 3b could grep the log for
// "offloaded"/"Vulkan0"/"CUDA0", this path did no such check, and a noisier
// banner would only evict error text from the fixed 64 KB stderr ring.
//
// Self-consistent, and the wrong trade. What it cost was the answer to "is this
// running on my GPU or my CPU" -- the FIRST troubleshooting entry in README.md
// -- which launch.bat printed on screen and this path could not, because the
// lines were not merely unread, they were never emitted. The ring objection is
// answered by the output now reaching the console as it happens
// (Options.ConsoleOut), so the ring is no longer the only copy of anything.
//
// llama.cpp files those lines above its default threshold: in common/log.cpp,
// common_get_verbosity maps GGML_LOG_LEVEL_INFO to LOG_LEVEL_TRACE (4) while
// the default is LOG_LEVEL_INFO (3). 4 is trace, not debug -- DEBUG is 5 and
// stays filtered -- so this asks for exactly the messages that used to arrive
// by default rather than opening the floodgates.
//
// -lv and the offload check are one decision, not two: either alone is useless,
// and passing neither is what made every GPU invisible. tests/test-engine-args.py
// holds the pairing and fails if one arrives without the other.
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

	// "mistral-v7-tekken" used to be rewritten to "mistral-v7" here, on the
	// grounds that shipped llama.cpp builds did not register the tekken name
	// and would treat it as a literal template body. That is no longer true —
	// the name landed between b5300 and b5600 and is present in every engine
	// this project has pinned (b8941, b9294, b10456) — and the rewrite was
	// actively harmful: the two templates differ by a space after [INST], which
	// on a Tekken tokenizer shifts token boundaries enough to drop the model
	// out of instruct mode (issue #20).
	//
	// Nothing replaces it. The classifier now decides between the model's own
	// embedded template and the correctly spaced built-in, and this is the
	// layer that carries that decision to llama-server rather than second-
	// guessing it.

	// Read the tuning once, so a /perf write landing mid-assembly cannot put
	// one model's context size next to another's KV cache type.
	tune := s.Tuning()

	gpuLayers := itoaInt(tune.GPULayers)
	if tune.GPULayers == -1 {
		gpuLayers = "auto"
	}
	args := []string{
		"--model", modelPath,
		"--port", s.port,
		"--host", s.host,
		"--ctx-size", itoaInt(tune.CtxSize),
		"--n-gpu-layers", gpuLayers,
		"--cache-type-k", tune.KVCacheType,
		"--cache-type-v", tune.KVCacheType,
		"--parallel", "1",
		// See the note above: without this the offload lines are never emitted
		// and engineWatch can never confirm a working GPU.
		"-lv", "4",
	}
	if tune.GPULayers == -1 {
		args = append(args, "--fit", "on", "--fit-target", itoaInt(s.opts.GPUReserveMiB), "--fit-ctx", itoaInt(tune.CtxSize))
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
	s.mu.Lock()
	blocked := s.closed || s.cmd != nil || s.pgid != 0
	s.mu.Unlock()
	if blocked {
		return fmt.Errorf("previous engine has not been released, or server is shutting down")
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(s.host, s.port), 200*time.Millisecond)
	if err == nil {
		conn.Close()
		return fmt.Errorf("engine port is already occupied; stop the existing server first")
	}

	modelPath := filepath.Join(s.opts.ModelDir, file)
	if _, err := os.Stat(modelPath); err != nil {
		return fmt.Errorf("model %s not found in %s", file, s.opts.ModelDir)
	}

	rec := models.IdentifyFile(modelPath)
	args := s.BuildArgs(rec, modelPath)
	if err := s.checkMemoryArgs(args); err != nil {
		return err
	}

	cmd := exec.Command(s.opts.ServerExe, args...)
	configureProcessGroup(cmd)

	s.stderr.Reset()
	s.engine.Reset()

	// Four destinations, each for a different question.
	//
	//   the ring     "why did this fail" -- quoted back immediately
	//   the log      the full history, for anything the ring rotated past
	//   the watcher  did it reach the GPU, is VRAM tight
	//   the console  what the user is watching right now
	//
	// The console is the one that was missing. Nothing that was already written
	// stops being written -- this adds a reader, it does not move the output.
	var (
		logFile *os.File
		console *prefixWriter
	)
	if s.opts.ConsoleOut != nil {
		// Prefixed, so two programs in one window stay tellable apart. This is
		// the "funnel it back to the gobbonet console" half of the fix.
		console = newPrefixWriter(s.opts.ConsoleOut, " [llama] ", !s.opts.EngineOutputFull)
	}

	errSinks := []io.Writer{s.stderr, s.engine}
	outSinks := []io.Writer{s.engine}
	if f, err := os.OpenFile(s.opts.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
		logFile = f
		errSinks = append(errSinks, logFile)
		outSinks = append(outSinks, logFile)
	}
	if console != nil {
		errSinks = append(errSinks, console)
		outSinks = append(outSinks, console)
	}
	cmd.Stderr = io.MultiWriter(errSinks...)
	cmd.Stdout = io.MultiWriter(outSinks...)
	s.console = console

	// No load announcement here. start() is reached from five places and every
	// one of them has already named the model in its own words -- "restart
	// attempt 2 for x", "rolling back to x", "WAKING -- reloading x for your
	// message". A line here as well meant two announcements per load, under two
	// different tags, for one event. The two callers that had nothing to say
	// (Boot and runSwap) say it themselves now.
	//
	// The full command line stays out of the console for its own reason: it is
	// ~300 characters and was the single longest thing on screen, scrolling the
	// event it announced out of view. It goes to the log file every time.
	if s.opts.EngineOutputFull {
		log.Printf("[swap] command: %s %s", s.opts.ServerExe, strings.Join(args, " "))
	}
	if err := cmd.Start(); err != nil {
		if logFile != nil {
			logFile.Close()
		}
		return fmt.Errorf("could not start llama-server: %w", err)
	}

	exited := make(chan struct{})

	// Tie the child's tree to this process's lifetime, so a kill that runs no
	// Go code here does not leave llama-server holding VRAM and the port. A
	// no-op on Unix; see killjob_unix.go for why.
	//
	// Failure is logged rather than fatal: this is a backstop for abnormal
	// exits, and losing it does not stop a model from running. Every explicit
	// cleanup path is unaffected.
	if err := superviseTree(cmd); err != nil {
		log.Printf("[swap] could not tie llama-server to this process's lifetime: %v", err)
		log.Printf("[swap] it will still be stopped normally; a forced kill of gobbonet may leave it running")
	}

	s.mu.Lock()
	s.cmd = cmd
	s.pgid = processGroupID(cmd)
	s.current = file
	s.exited = exited
	s.mu.Unlock()

	// Publish all state before the reaper can observe an exit.
	s.mu.Lock()
	s.generation++
	generation := s.generation
	s.mu.Unlock()
	go func() {
		err := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		if console != nil {
			console.Flush()
		}
		s.mu.Lock()
		close(exited)
		s.mu.Unlock()
		// Cleanup waits on exited, never on this lock. Decide recovery only after
		// the transition that launched/stopped this child has finished.
		s.opMu.Lock()
		s.mu.Lock()
		restart := s.cmd == cmd && !s.closed && !s.stopping && !s.swapping && !s.stoodDown && s.usable
		s.mu.Unlock()
		s.opMu.Unlock()
		if restart {
			log.Printf("[swap] llama-server exited unexpectedly: %v", err)
			s.restartGeneration(file, generation)
		}
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
//
// Every failed attempt publishes its reason through setStatus, not just the log.
// This loop used to log and move on, which left /swap-status reporting the
// "ready" it was set to before the crash — so the one endpoint a client can ask
// "is the model up, and if not why" answered with a stale yes while nothing was
// listening. The landing page now shows this text verbatim (issue #43), so a
// wrong answer here is a wrong answer on screen.
func (s *Supervisor) restartAfterCrash(file string) {
	s.mu.Lock()
	generation := s.generation
	s.mu.Unlock()
	s.restartGeneration(file, generation)
}

// One retry loop owns recovery. Failed startup children do not spawn more
// loops; stale loops cannot revive a model after a swap, a stand-down or
// shutdown -- each of those ends this loop at its next check.
//
// It retries until it succeeds, backing off from one second to two minutes,
// as 1.7.5 did. A bounded loop gives up during exactly the outages recovery
// exists for: a GPU driver reset, or a card another program is holding, can
// take longer than a few seconds to clear, and afterwards the only way back
// was selecting a model by hand. Choosing a model at any point still takes
// over immediately (Swap ends this loop through `swapping`).
func (s *Supervisor) restartGeneration(file string, generation uint64) {
	backoff := s.opts.RecoveryBackoff
	if backoff <= 0 {
		backoff = time.Second
	}
	const maxBackoff = 2 * time.Minute
	for attempt := 1; ; attempt++ {
		select {
		case <-s.shutdown:
			return
		case <-time.After(backoff):
		}
		s.opMu.Lock()
		s.mu.Lock()
		busy := s.closed || s.swapping || s.stopping || s.stoodDown || s.generation != generation
		s.mu.Unlock()
		if busy {
			s.opMu.Unlock()
			return
		}
		log.Printf("[swap] restart attempt %d for %s", attempt, file)
		err := s.stop()
		if err == nil {
			s.setStatus(PhaseStarting, file, file, "Recovering model", time.Now().Unix())
			err = s.load(file)
		}
		s.mu.Lock()
		generation = s.generation
		s.mu.Unlock()
		if err != nil {
			// The reason goes to the console as well as /swap-status: this loop
			// can run for a long time, and "attempt 7" with no cause is noise.
			log.Printf("[swap] restart failed: %v", err)
			s.setStatus(PhaseError, file, file, err.Error(), time.Now().Unix())
		} else {
			log.Printf("[swap] llama-server recovered")
			s.setStatus(PhaseReady, file, file, "Ready", time.Now().Unix())
			if s.OnReady != nil {
				s.OnReady()
			}
		}
		s.opMu.Unlock()
		if err == nil {
			return
		}
		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// load owns cleanup even if the child stays alive but never becomes healthy.
// Caller holds opMu. Explicit settings are not silently reduced on failure.
func (s *Supervisor) load(file string) error {
	if err := s.start(file); err != nil {
		return err
	}
	timeout := s.opts.LoadTimeout
	if timeout <= 0 {
		timeout = swapTimeout
	}
	if err := s.waitHealthy(time.Now().Add(timeout)); err != nil {
		if cleanup := s.stop(); cleanup != nil {
			return fmt.Errorf("%w; cleanup: %v", err, cleanup)
		}
		return err
	}
	s.mu.Lock()
	select {
	case <-s.exited:
		s.mu.Unlock()
		cleanup := s.stop()
		return fmt.Errorf("engine exited immediately after readiness (cleanup: %v)", cleanup)
	default:
	}
	s.stoodDown = false
	s.usable = true
	s.standFile = ""
	s.lastUse = time.Now()
	s.mu.Unlock()
	return nil
}

// stop ends the running process and waits for the port to be released.
//
// The wait is not optional. Kill returns before the kernel has released the
// listening socket; spawning the replacement too early makes its bind() fail and
// it exits within milliseconds, leaving /swap-status at "starting" until the
// timeout — which looks exactly like a model that is slow to load.
func (s *Supervisor) stop() error {
	s.mu.Lock()
	cmd := s.cmd
	pgid := s.pgid
	exited := s.exited
	s.stopping = true
	s.usable = false
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		s.stopping = false
		// Retain ownership if cleanup failed, so no replacement can overlap.
		if !groupAlive(pgid) {
			s.cmd = nil
			s.pgid = 0
			releaseTree(pgid)
		}
		s.mu.Unlock()
	}()

	if (cmd == nil || cmd.Process == nil) && pgid == 0 {
		return nil
	}
	if cmd == nil || cmd.Process == nil {
		// No leader handle, but possibly still an owned group of helpers.
		if err := s.reapGroup(pgid); err != nil {
			return err
		}
		return s.waitPortFree()
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

	if err := s.reapGroup(pgid); err != nil {
		return err
	}
	return s.waitPortFree()
}

// reapGroup ensures nothing from the launched process group is left running.
//
// Membership, not the leader's exit status, is the completion condition — a
// helper that ignored SIGTERM, or one orphaned when llama-server crashed, is
// invisible to cmd.Wait() and to any walk of our own descendants, but it still
// holds the GPU memory the next model needs.
func (s *Supervisor) reapGroup(pgid int) error {
	if pgid <= 0 || !groupAlive(pgid) {
		return nil
	}

	// The leader may already have taken the polite signal; members still here
	// have either ignored it or never received one.
	if err := terminateGroup(pgid, false); err != nil {
		log.Printf("[swap] SIGTERM to process group failed: %v", err)
	}
	if waitGroupGone(pgid, gracePeriod) {
		return nil
	}

	log.Printf("[swap] process group %d outlived SIGTERM; forcing", pgid)
	if err := terminateGroup(pgid, true); err != nil {
		log.Printf("[swap] SIGKILL to process group failed: %v", err)
	}
	if !waitGroupGone(pgid, gracePeriod) {
		// Worth shouting about: this is the state in which a swap will fail to
		// allocate VRAM, and the cause is not something the next error message
		// will explain.
		return fmt.Errorf("process group %d survived termination; refusing to load another model", pgid)
	}
	return nil
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
func (s *Supervisor) waitPortFree() error {
	deadline := time.Now().Add(portFreeTimeout)
	address := net.JoinHostPort(s.host, s.port)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", address, 200*time.Millisecond)
		if err != nil {
			return nil
		}
		conn.Close()
		time.Sleep(250 * time.Millisecond)
	}
	return fmt.Errorf("port %s is still occupied; refusing to start another engine", address)
}

// waitHealthy polls the upstream's /health until it answers 200.
func (s *Supervisor) waitHealthy(deadline time.Time) error {
	for time.Now().Before(deadline) {
		s.mu.Lock()
		exited := s.exited
		closed := s.closed
		s.mu.Unlock()
		if closed {
			return fmt.Errorf("server is shutting down")
		}

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
		select {
		case <-s.shutdown:
			return fmt.Errorf("server is shutting down")
		case <-time.After(healthProbeInterval):
		}
	}
	if msg := s.stderr.LastError(); msg != "" {
		return fmt.Errorf("%s", msg)
	}
	return fmt.Errorf("model did not respond within %s", swapTimeout)
}

// Boot starts the initial model. Picks the configured model if there is one,
// otherwise the first GGUF in the model directory.
func (s *Supervisor) Boot(preferred string) error {
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.mu.Lock()
	closed := s.closed
	occupied := s.cmd != nil || s.pgid != 0
	s.mu.Unlock()
	if closed || occupied {
		return fmt.Errorf("engine is already owned or shutting down")
	}
	file := preferred
	if file == "" {
		records := models.ScanDir(s.opts.ModelDir)
		if len(records) == 0 {
			return fmt.Errorf("no .gguf files in %s", s.opts.ModelDir)
		}
		file = records[0].File
	}

	began := time.Now()
	startedAt := began.Unix()
	s.setStatus(PhaseStarting, file, file, "Loading model", startedAt)

	log.Printf("[swap] LOADING %s", file)
	if err := s.load(file); err != nil {
		s.setStatus(PhaseError, file, file, err.Error(), startedAt)
		return err
	}

	s.mu.Lock()
	s.previous = file
	s.mu.Unlock()

	// NOT announced here. Boot is called once, from cmd/gobbonet, which prints
	// the banner's own "[OK] model loaded" and GPU report immediately after --
	// so announcing would say the same thing twice in two different voices.
	// The summary is handed to that report instead (LoadSummaryLine below).
	_ = began
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
	modelPath := filepath.Join(s.opts.ModelDir, file)
	info, err := os.Stat(modelPath)
	if err != nil || !info.Mode().IsRegular() {
		return fmt.Errorf("model %q not found in %s", file, s.opts.ModelDir)
	}

	s.mu.Lock()
	if s.swapping || s.closed {
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
	s.opMu.Lock()
	defer s.opMu.Unlock()
	defer func() {
		s.mu.Lock()
		s.swapping = false
		s.mu.Unlock()
	}()

	// Kill-then-start, not start-then-kill. On a single GPU there is not enough
	// VRAM to hold two models at once, so the old one must be fully gone before
	// the new one begins loading.
	if err := s.stop(); err != nil {
		s.setStatus(PhaseError, file, name, err.Error(), startedAt)
		return
	}
	s.setStatus(PhaseStarting, file, name, "Loading new model", startedAt)

	began := time.Now()
	log.Printf("[swap] LOADING %s", file)
	if err := s.load(file); err != nil {
		s.rollback(previous, file, name, startedAt, err.Error())
		return
	}

	s.mu.Lock()
	s.previous = file
	s.mu.Unlock()

	s.announceLoad("swap", "loaded", file, began)
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
	if err := s.stop(); err != nil {
		s.setStatus(PhaseError, failedFile, failedName, reason+"; "+err.Error(), startedAt)
		return
	}

	if previous == "" || previous == failedFile {
		s.setStatus(PhaseError, failedFile, failedName, reason, startedAt)
		return
	}

	log.Printf("[swap] rolling back to %s", previous)
	if err := s.load(previous); err != nil {
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
	if !s.closed {
		s.closed = true
		close(s.shutdown)
	}
	s.mu.Unlock()
	s.opMu.Lock()
	defer s.opMu.Unlock()
	if err := s.stop(); err != nil {
		log.Printf("[swap] shutdown cleanup: %v", err)
	}
}
