// Package supervisor owns the local llama-server process: starting it at boot,
// restarting it when it dies, and hot-swapping the loaded GGUF on request.
//
// Up to 1.7.9 this logic could live in two places at once on Windows —
// launch.bat's monitor loop and the PowerShell server's swap handler — which is
// exactly the drift the Go port existed to remove. 1.8.0 removed both; it is one
// state machine in one process.
//
// Only local mode uses this. In remote mode llama.cpp belongs to somebody else
// and /swap-model answers 503, which is the same honest answer the PowerShell
// server gave whenever launch.bat had not handed it a server executable.
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
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/engine"
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
	// swapTimeout is the load timeout when Options.LoadTimeout is unset. The
	// server sets it from model_load_timeout_seconds in config.toml (default
	// 180), and /swap-status reports it so the chat page's poll can outlast it:
	// the page must never give up while the server still believes it is
	// working, or the user sees a failure with no reason for it.
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
	// LoadTimeout bounds one model load. From model_load_timeout_seconds in
	// config.toml; zero means swapTimeout. Tests use a short deadline.
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

	// Device is the --device argument (1.8.0, #72): "" leaves the choice to
	// llama.cpp, "none" is CPU only, otherwise device IDs. Already resolved
	// against the engine's device list (engine.ResolveDevice); changed later
	// through SetDevice, like Tuning.
	Device string
	// PrimeOffload sets engine.PrimeEnv on the engine process (Linux only).
	PrimeOffload bool
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
	// LoadTimeoutSeconds is how long this server lets a load run. The chat
	// page waits that long plus a margin before it gives up on its own.
	LoadTimeoutSeconds int `json:"load_timeout_seconds,omitempty"`
	// Busy is true while a reply is being written for any device (1.8.0,
	// #52). A page that wants to switch models on its own -- a chat that
	// remembers another model -- waits for it rather than cutting a reply off.
	Busy bool `json:"busy,omitempty"`
	// When a load failed (1.8.0, #67): Cause is a key from cause.go, Advice
	// the one plain sentence for it, and Log names the engine's own log. The
	// raw line stays in Message, for a "details" toggle. Log is the file's
	// name only: the folder is this PC's, and gobbonet doctor shows it there.
	Cause  string `json:"cause,omitempty"`
	Advice string `json:"advice,omitempty"`
	Log    string `json:"log,omitempty"`
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
	// device and primeOffload: see Options.Device. Guarded by mu.
	device       string
	primeOffload bool
	cmd          *exec.Cmd
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
	// were reported on screen by launch.bat's old STEP 3b (removed in 1.8.0)
	// and by nothing at all on this path. Reset per launch, like the stderr ring beside it.
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

	// OnStandDown and OnWake run when idle stand-down unloads the model and
	// when the next message brings it back (1.8.0, #15): the embedding server
	// stands down and comes back with it. OnStandDown runs after the model is
	// down, OnWake after it has loaded, so the chat model is fitted to the GPU
	// first. Both run with this supervisor's transition lock held, so they must
	// not call back into it.
	OnStandDown func()
	OnWake      func()
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
		opts:         opts,
		shutdown:     make(chan struct{}),
		tuning:       opts.Tuning,
		device:       opts.Device,
		primeOffload: opts.PrimeOffload,
		host:         host,
		port:         port,
		stderr:       newRingBuffer(stderrRingSize),
		engine:       newEngineWatch(),
		client:       &http.Client{Timeout: 3 * time.Second},
		status:       Status{Phase: PhaseIdle},
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

// Device is the --device argument the next start will use ("" = automatic),
// and whether the PRIME pair goes with it.
func (s *Supervisor) Device() (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.device, s.primeOffload
}

// SetDevice changes the GPU the NEXT llama-server start uses, as SetTuning
// does: the page then restarts the model through the swap path.
func (s *Supervisor) SetDevice(arg string, prime bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.device, s.primeOffload = arg, prime
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
	st := s.status
	st.LoadTimeoutSeconds = int(s.loadTimeout() / time.Second)
	st.Busy = s.inFlight > 0
	return st
}

// loadTimeout is how long one load may take.
func (s *Supervisor) loadTimeout() time.Duration {
	if s.opts.LoadTimeout > 0 {
		return s.opts.LoadTimeout
	}
	return swapTimeout
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

// setFailure publishes a failed load: the error phase with message as the
// reason, plus the cause err carries, if any, and its plain sentence.
func (s *Supervisor) setFailure(file, name, message string, startedAt int64, err error) {
	s.setStatus(PhaseError, file, name, message, startedAt)
	cause := causeOf(err)
	s.mu.Lock()
	defer s.mu.Unlock()
	s.status.Cause = cause
	s.status.Advice = CauseAdvice(cause)
	if s.opts.LogFile != "" {
		s.status.Log = filepath.Base(s.opts.LogFile)
	}
}

// --- Command construction --------------------------------------------------

// BuildArgs assembles the llama-server command line for a model record.
//
// This is the ONLY builder, so every package starts llama-server identically.
// Up to 1.7.9 launch.bat's :start_server block and the PowerShell server's
// Build-LaunchScript were batch/PowerShell equivalents that could disagree with
// it; 1.8.0 removed both, and launch.bat now starts only the embedding server.
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
	device, _ := s.Device()

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
		args = append(args, "--fit", "on", "--fit-target", itoaInt(s.fitTargetMiB(rec)), "--fit-ctx", itoaInt(tune.CtxSize))
	}
	// gpu_device (1.8.0, #72): one argument, already checked against the
	// engine's own device list. Absent means llama.cpp chooses.
	if device != "" {
		args = append(args, "--device", device)
	}
	// A built-in template NAME only means something to llama.cpp's legacy
	// (non-Jinja) formatter. With Jinja on, llama-server takes the
	// --chat-template value as Jinja *source*, so "mistral-v7-tekken" renders
	// as that literal string for every request: the model never sees the
	// conversation and free-associates on the word "tekken" (1.7.9, every
	// Tekken model). So a name always travels with Jinja off, whatever the
	// record said.
	if chatTemplateFile == "" && chatTemplate != "" {
		useJinja = false
	}
	// Jinja's state is always stated, never left to the engine's default.
	// The pinned engine (b10456) has Jinja on by default, so leaving out
	// --jinja no longer turns it off -- the assumption behind the bug above.
	if useJinja {
		args = append(args, "--jinja")
	} else {
		args = append(args, "--no-jinja")
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

// MoEFitTargetMiB is the least free-VRAM target automatic placement uses for a
// Mixture-of-Experts model. gpu_reserve_mib still applies when it is larger.
//
// Why MoE models need more room than dense ones: the engine's fit pass is
// MoE-aware and already keeps most expert weights in system RAM, but on a card
// the model does not fit it lands right at the target, and the 1024 MiB default
// does not cover the compute buffers allocated after loading plus whatever the
// desktop holds. The driver then pages ~1 GB of the engine's allocations out to
// system RAM, silently. Measured on an 8 GB RTX 4070 Laptop with the pinned
// engine, through gobbonet.exe, stock config (issue #65):
//
//	Qwen3.6 35B-A3B   13.3 t/s at 1024  ->  21.6 t/s at 2048
//	gpt-oss 20B        9.3 t/s at 1024  ->  20.3 t/s at 2048
//	Gemma 4 26B-A4B   prompt 54 t/s     ->  169 t/s      (generation unchanged)
//
// Dense models are not affected by this floor (they keep gpu_reserve_mib), and
// they should not be: with 2048 a dense 9B that fit with 1024 lost 4 of 33
// layers to the CPU and dropped from 38.7 to 22.4 t/s. A MoE model that fits
// entirely with 1 GB spare pays at most one layer's experts for the extra room.
const MoEFitTargetMiB = 2048

// fitTargetMiB is the --fit-target handed to llama-server for rec.
func (s *Supervisor) fitTargetMiB(rec models.Record) int {
	if rec.ExpertCount > 0 && s.opts.GPUReserveMiB < MoEFitTargetMiB {
		return MoEFitTargetMiB
	}
	return s.opts.GPUReserveMiB
}

// --- Process lifecycle -----------------------------------------------------

// start spawns llama-server for the named GGUF. It does not wait for readiness.
func (s *Supervisor) start(file string) error {
	s.mu.Lock()
	blocked := s.closed || s.cmd != nil || s.pgid != 0
	s.mu.Unlock()
	if blocked {
		return fmt.Errorf("previous engine has not been released, or server is shutting down")
	}
	if addrInUse(net.JoinHostPort(s.host, s.port)) {
		return fmt.Errorf("engine port is already occupied; stop the existing server first")
	}

	modelPath := filepath.Join(s.opts.ModelDir, file)
	if _, err := os.Stat(modelPath); err != nil {
		return &LoadError{Cause: CauseFileNotFound, Line: fmt.Sprintf("model %s not found in %s", file, s.opts.ModelDir)}
	}

	rec := models.IdentifyFile(modelPath)
	args := s.BuildArgs(rec, modelPath)
	if err := s.checkMemoryArgs(args); err != nil {
		return err
	}

	cmd := exec.Command(s.opts.ServerExe, args...)
	// gpu_prime_offload (1.8.0, #72): the fixed pair, on this process only.
	if _, prime := s.Device(); prime && runtime.GOOS == "linux" {
		cmd.Env = append(os.Environ(), engine.PrimeEnv...)
	}

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
		// Where this run begins, so gobbonet doctor can read the last load
		// alone out of a log that keeps every run (1.8.0, #67).
		fmt.Fprintf(logFile, "\n%s%s at %s ===\n", logRunMarker, file, time.Now().Format(time.RFC3339))
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
	// Its own process group, tied to this process's lifetime so a kill that
	// runs no Go code here does not leave llama-server holding VRAM and the
	// port (managed.go, shared with the embedding server).
	pgid, err := spawnTree(cmd, "[swap]", "llama-server")
	if err != nil {
		if logFile != nil {
			logFile.Close()
		}
		return err
	}

	exited := make(chan struct{})

	s.mu.Lock()
	s.cmd = cmd
	s.pgid = pgid
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
	recoveryLoop(s.opts.RecoveryBackoff, s.shutdown, func(attempt int) bool {
		s.opMu.Lock()
		s.mu.Lock()
		busy := s.closed || s.swapping || s.stopping || s.stoodDown || s.generation != generation
		s.mu.Unlock()
		if busy {
			s.opMu.Unlock()
			return true
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
			s.setFailure(file, file, err.Error(), time.Now().Unix(), err)
		} else {
			log.Printf("[swap] llama-server recovered")
			s.setStatus(PhaseReady, file, file, "Ready", time.Now().Unix())
			if s.OnReady != nil {
				s.OnReady()
			}
		}
		s.opMu.Unlock()
		return err == nil
	})
}

// load owns cleanup even if the child stays alive but never becomes healthy.
// Caller holds opMu. Explicit settings are not silently reduced on failure.
func (s *Supervisor) load(file string) error {
	if err := s.start(file); err != nil {
		return err
	}
	if err := s.waitHealthy(time.Now().Add(s.loadTimeout())); err != nil {
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

	// No leader handle means possibly still an owned group of helpers: sweep
	// it. Otherwise the whole sequence, including when the leader has already
	// gone -- the normal case on the rollback path, where the model we were
	// asked to load failed and died before we got here. Its helpers can still
	// be holding VRAM; returning early is what leaves the next model unable to
	// allocate a backend buffer (managed.go, endTree).
	haveLeader := cmd != nil && cmd.Process != nil
	if err := endTree(pgid, exited, haveLeader, "[swap]", "llama-server"); err != nil {
		return err
	}
	return waitAddrFree(net.JoinHostPort(s.host, s.port))
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
			if f := s.stderr.failure(); f != nil {
				return f
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
	if f := s.stderr.failure(); f != nil {
		return f
	}
	// The configured timeout, not the default: the message has to name the
	// number the user can change, and where.
	return fmt.Errorf("model did not finish loading within %s. A big model on a slow disk or the CPU can need longer: "+
		"raise model_load_timeout_seconds in config.toml (CONFIG > Config File) and restart GobboNet", s.loadTimeout())
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
		s.setFailure(file, file, err.Error(), startedAt, err)
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

// ErrBusy is SwapAuto's answer while a reply is being written (1.8.0, #52).
// One engine serves every device, and a swap stops it, so a switch nobody
// clicked must never end someone's reply -- on this device or another.
var ErrBusy = fmt.Errorf("a reply is being written right now, so the model was not switched")

// Swap changes the loaded model. It returns as soon as the swap is dispatched;
// the client polls /swap-status for the outcome.
//
// file is a name in the models folder and nothing else (1.8.0). It arrives
// from any signed-in device, and from cards and synced chats once a character
// can name its model (#52). Until 1.8.0 it was joined onto the folder
// unchecked, so "../elsewhere/x.gguf" was started from outside it. Links inside
// the folder still work: USE IT puts found models there that way.
//
// Neither error names the models folder's path. The answer goes to whichever
// device asked, and where models live on this PC is not its business; the
// server's own log has the path.
func (s *Supervisor) Swap(file string) error { return s.swap(file, false) }

// SwapAuto is Swap for a switch the page makes on its own: opening a chat
// that remembers another model, or a character linked to one (1.8.0, #52).
// It is refused with ErrBusy while any request is in flight, checked under the
// same lock that starts the swap, so no reply can begin in between. A swap
// someone picked from the model menu is Swap, and behaves as it always has.
func (s *Supervisor) SwapAuto(file string) error { return s.swap(file, true) }

func (s *Supervisor) swap(file string, auto bool) error {
	if err := models.CheckFileName(file); err != nil {
		log.Printf("[swap] refused %q: %v", truncate(file, 200), err)
		return fmt.Errorf("not a model file name: send just the file's name in the models folder, ending in .gguf")
	}
	modelPath := filepath.Join(s.opts.ModelDir, file)
	info, err := os.Stat(modelPath)
	if err != nil || !info.Mode().IsRegular() {
		log.Printf("[swap] %s: not a model file in %s", file, s.opts.ModelDir)
		return fmt.Errorf("model %q not found in the models folder", file)
	}

	s.mu.Lock()
	if s.swapping || s.closed {
		s.mu.Unlock()
		return ErrSwapInFlight
	}
	if auto && s.inFlight > 0 {
		n := s.inFlight
		s.mu.Unlock()
		log.Printf("[swap] automatic switch to %s refused: %d request(s) in flight", file, n)
		return ErrBusy
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
		s.rollback(previous, file, name, startedAt, err)
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
func (s *Supervisor) rollback(previous, failedFile, failedName string, startedAt int64, loadErr error) {
	reason := loadErr.Error()
	log.Printf("[swap] %s failed to load: %s", failedFile, reason)
	if advice := CauseAdvice(causeOf(loadErr)); advice != "" {
		log.Printf("[swap] %s", advice)
	}
	if err := s.stop(); err != nil {
		s.setFailure(failedFile, failedName, reason+"; "+err.Error(), startedAt, loadErr)
		return
	}

	if previous == "" || previous == failedFile {
		s.setFailure(failedFile, failedName, reason, startedAt, loadErr)
		return
	}

	log.Printf("[swap] rolling back to %s", previous)
	if err := s.load(previous); err != nil {
		s.setFailure(failedFile, failedName,
			fmt.Sprintf("%s (rollback to %s also failed: %v)", reason, previous, err), startedAt, loadErr)
		return
	}

	if s.OnReady != nil {
		s.OnReady()
	}
	// The phase is 'error' because the swap the user asked for did not happen,
	// but the message says the server is still usable — which is the part they
	// need to know before deciding what to do next.
	s.setFailure(failedFile, failedName,
		fmt.Sprintf("%s — rolled back to %s, which is still running.", reason, previous), startedAt, loadErr)
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
