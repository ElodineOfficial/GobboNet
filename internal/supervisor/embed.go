package supervisor

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Embedder runs the embedding server semantic search uses (1.8.0, #15).
//
// Until 1.8.0 a launcher script started it and nothing watched it: a crash
// turned semantic search off with no notice, and a Start-menu launch, which
// never ran the script, never started it at all. Now it is a second managed
// child of this process, with the same process group, Windows job and restart
// loop as llama-server (managed.go). PR #56 (orcmaul) restarted it from
// launch.bat's monitor loop; that loop is gone, and this is where the idea
// lives now.
//
// What it adds over the chat model's supervisor is small and specific:
//
//   - the model is checked against its SHA-256 pin before every start, and a
//     missing or mismatched model is reported, never retried in a loop;
//   - a server it did not start, already answering on the port, is used as
//     it is ("external") and looked at again until it goes, rather than
//     fought over;
//   - it stands down and comes back with the chat model (StandDown, Wake).

// Embedding server states, as /health-fileserver reports them under "embed".
const (
	EmbedStarting   = "starting"
	EmbedRunning    = "running"
	EmbedRestarting = "restarting" // crashed, or failed to start; retrying with backoff
	EmbedStandby    = "standby"    // stood down with the chat model; back on the next message
	EmbedFailed     = "failed"     // will not start until something changes; Detail says what
	EmbedExternal   = "external"   // something else is answering on embed_url
	EmbedOff        = "off"
)

const (
	embedLoadTimeout = 60 * time.Second
	embedAdoptPoll   = 30 * time.Second
	embedRingSize    = 16 * 1024
)

// EmbedOptions configures an Embedder.
type EmbedOptions struct {
	ServerExe string
	// Model is the GGUF to start; Pin the SHA-256 it must have, or "" for a
	// model of the user's own choosing (config.EmbedModelPath).
	Model string
	Pin   string
	// URL is embed_url: the address it binds and GobboNet reaches it at.
	URL       string
	Ctx       int
	GPULayers int

	LogFile          string
	ConsoleOut       io.Writer
	EngineOutputFull bool

	// Test knobs; zero means the real values.
	RecoveryBackoff time.Duration
	LoadTimeout     time.Duration
	AdoptPoll       time.Duration
}

// EmbedStatus is what the page is told.
type EmbedStatus struct {
	State  string `json:"state"`
	Detail string `json:"detail,omitempty"`
	Model  string `json:"model,omitempty"`
}

// errPermanent marks a start that cannot work until something changes (a
// missing or mismatched model): reported, not retried.
type errPermanent struct{ msg string }

func (e *errPermanent) Error() string { return e.msg }

// Embedder supervises one embedding server.
type Embedder struct {
	opts   EmbedOptions
	host   string
	port   string
	client *http.Client
	stderr *ringBuffer

	// opMu serializes starts and stops; never acquire it while holding mu.
	opMu sync.Mutex
	mu   sync.Mutex

	cmd    *exec.Cmd
	pgid   int
	exited chan struct{}

	// gen changes on every deliberate transition (start, stand-down,
	// shutdown), so a recovery loop or adoption watch started for an older
	// one ends at its next look.
	gen      uint64
	want     bool // Start was called and nothing has stood it down since
	standby  bool
	closed   bool
	shutdown chan struct{}
	status   EmbedStatus
}

// NewEmbedder builds an Embedder. It starts nothing until Start.
func NewEmbedder(opts EmbedOptions) (*Embedder, error) {
	u, err := url.Parse(opts.URL)
	if err != nil || u.Hostname() == "" || u.Port() == "" {
		return nil, fmt.Errorf("embed_url %q: a managed embedding server needs a host and a port", opts.URL)
	}
	if opts.Ctx <= 0 {
		opts.Ctx = 2048
	}
	return &Embedder{
		opts:     opts,
		host:     u.Hostname(),
		port:     u.Port(),
		client:   &http.Client{Timeout: 3 * time.Second},
		stderr:   newRingBuffer(embedRingSize),
		shutdown: make(chan struct{}),
		status:   EmbedStatus{State: EmbedOff, Model: filepath.Base(opts.Model)},
	}, nil
}

// EmbedArgs is the embedding server's command line. The same on every
// platform: --pooling mean because nomic/e5-style embedders need it, and the
// batch sizes raised to the context because an embedder must take each input
// whole -- llama-server's default ubatch of 512 silently refused anything
// longer. (The Linux launcher used to leave both batch flags off; the page's
// sub-512-token slicing covered for it.)
func EmbedArgs(model, host, port string, ctx, gpuLayers int) []string {
	c := strconv.Itoa(ctx)
	return []string{
		"--model", model,
		"--host", host,
		"--port", port,
		"--embeddings",
		"--pooling", "mean",
		"--ctx-size", c,
		"--batch-size", c,
		"--ubatch-size", c,
		"--n-gpu-layers", strconv.Itoa(gpuLayers),
	}
}

// Status reports the current state.
func (e *Embedder) Status() EmbedStatus {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.status
}

func (e *Embedder) setStatus(state, detail string) {
	e.mu.Lock()
	changed := e.status.State != state || e.status.Detail != detail
	e.status.State, e.status.Detail = state, detail
	e.mu.Unlock()
	if !changed {
		return
	}
	switch state {
	case EmbedRunning:
		log.Printf("[embed] embedding server ready on :%s -- semantic search is on", e.port)
	case EmbedFailed, EmbedRestarting, EmbedExternal:
		if detail != "" {
			log.Printf("[embed] %s: %s", state, detail)
		}
	}
}

func (e *Embedder) address() string { return net.JoinHostPort(e.host, e.port) }

// Start brings the embedding server up in the background.
func (e *Embedder) Start() {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return
	}
	e.want = true
	e.standby = false
	e.gen++
	gen := e.gen
	e.status.State, e.status.Detail = EmbedStarting, ""
	e.mu.Unlock()
	go e.bringUp(gen)
}

// bringUp makes one attempt and hands a failure that may clear to the
// recovery loop.
func (e *Embedder) bringUp(gen uint64) {
	err := e.attempt(gen, EmbedStarting)
	var perm *errPermanent
	switch {
	case err == nil, errors.Is(err, errSuperseded), errors.Is(err, errAdopted):
	case errors.As(err, &perm):
		e.setStatus(EmbedFailed, err.Error())
	default:
		e.setStatus(EmbedRestarting, err.Error())
		e.recover(gen)
	}
}

var (
	errSuperseded = errors.New("superseded")
	errAdopted    = errors.New("adopted")
)

// attempt starts the server once and waits for it to answer. It owns cleanup
// of what it started when that fails.
func (e *Embedder) attempt(gen uint64, state string) error {
	e.opMu.Lock()
	defer e.opMu.Unlock()
	if !e.current(gen) {
		return errSuperseded
	}

	// A stale child from an earlier generation must be gone first.
	if err := e.stopLocked(); err != nil {
		return err
	}

	if st, err := os.Stat(e.opts.Model); err != nil || !st.Mode().IsRegular() {
		return &errPermanent{fmt.Sprintf("no embedding model at %s. Semantic search stays off until it is there: "+
			"the Windows first run (launch.bat) and the Linux setup wizard download it", e.opts.Model)}
	}
	if e.opts.Pin != "" {
		got, err := fileSHA256(e.opts.Model)
		if err != nil {
			return &errPermanent{fmt.Sprintf("could not read %s: %v", e.opts.Model, err)}
		}
		if got != e.opts.Pin {
			return &errPermanent{fmt.Sprintf("%s does not match its pinned SHA-256 (expected %s, got %s), so it was not started. "+
				"Delete it and run setup again to download it afresh", filepath.Base(e.opts.Model), e.opts.Pin[:12], got[:12])}
		}
	}

	// Something already on the port. If it answers like an embedding server,
	// use it -- an older launcher may have started one, or the user runs their
	// own -- and look again later; GobboNet takes over when it goes.
	if addrInUse(e.address()) {
		if e.healthy() {
			e.setStatus(EmbedExternal, fmt.Sprintf("an embedding server GobboNet did not start is already answering on :%s; using it", e.port))
			go e.watchAdopted(gen)
			return errAdopted
		}
		return fmt.Errorf("port %s is taken by something that is not an embedding server", e.port)
	}

	e.setStatus(state, "")
	cmd := exec.Command(e.opts.ServerExe, EmbedArgs(e.opts.Model, e.host, e.port, e.opts.Ctx, e.opts.GPULayers)...)
	e.stderr.Reset()
	errSinks := []io.Writer{e.stderr}
	var outSinks []io.Writer
	var logFile *os.File
	if e.opts.LogFile != "" {
		if f, err := os.OpenFile(e.opts.LogFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600); err == nil {
			logFile = f
			errSinks = append(errSinks, f)
			outSinks = append(outSinks, f)
			fmt.Fprintf(f, "\n=== GobboNet: starting the embedding server for %s at %s ===\n", filepath.Base(e.opts.Model), time.Now().Format(time.RFC3339))
		}
	}
	var console *prefixWriter
	if e.opts.ConsoleOut != nil {
		console = newPrefixWriter(e.opts.ConsoleOut, " [embed] ", !e.opts.EngineOutputFull)
		errSinks = append(errSinks, console)
		outSinks = append(outSinks, console)
	}
	cmd.Stderr = io.MultiWriter(errSinks...)
	if len(outSinks) > 0 {
		cmd.Stdout = io.MultiWriter(outSinks...)
	}

	pgid, err := spawnTree(cmd, "[embed]", "the embedding server")
	if err != nil {
		if logFile != nil {
			logFile.Close()
		}
		return &errPermanent{err.Error()}
	}
	exited := make(chan struct{})
	e.mu.Lock()
	e.cmd, e.pgid, e.exited = cmd, pgid, exited
	e.mu.Unlock()

	go func() {
		waitErr := cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		if console != nil {
			console.Flush()
		}
		close(exited)
		e.mu.Lock()
		unplanned := e.cmd == cmd && e.want && !e.standby && !e.closed && e.gen == gen && e.status.State == EmbedRunning
		e.mu.Unlock()
		if unplanned {
			detail := "the embedding server stopped unexpectedly"
			if waitErr != nil {
				detail += " (" + waitErr.Error() + ")"
			}
			if f := e.stderr.failure(); f != nil && f.Line != "" {
				detail += ": " + f.Line
			}
			e.setStatus(EmbedRestarting, detail)
			e.recover(gen)
		}
	}()

	if err := e.waitHealthy(gen, exited); err != nil {
		if cleanup := e.stopLocked(); cleanup != nil {
			return fmt.Errorf("%v; cleanup: %v", err, cleanup)
		}
		return err
	}
	if !e.current(gen) {
		_ = e.stopLocked()
		return errSuperseded
	}
	e.setStatus(EmbedRunning, "")
	return nil
}

// recover retries with the shared backoff until the server answers, the
// failure turns out to be one that will not clear, or the generation moves on.
func (e *Embedder) recover(gen uint64) {
	recoveryLoop(e.opts.RecoveryBackoff, e.shutdown, func(n int) bool {
		if !e.current(gen) {
			return true
		}
		log.Printf("[embed] restart attempt %d", n)
		err := e.attempt(gen, EmbedRestarting)
		var perm *errPermanent
		switch {
		case err == nil:
			log.Printf("[embed] embedding server recovered")
			return true
		case errors.Is(err, errSuperseded), errors.Is(err, errAdopted):
			return true
		case errors.As(err, &perm):
			e.setStatus(EmbedFailed, err.Error())
			return true
		default:
			e.setStatus(EmbedRestarting, err.Error())
			return false
		}
	})
}

// watchAdopted looks at a server it did not start until that one goes, then
// starts its own.
func (e *Embedder) watchAdopted(gen uint64) {
	poll := e.opts.AdoptPoll
	if poll <= 0 {
		poll = embedAdoptPoll
	}
	for {
		select {
		case <-e.shutdown:
			return
		case <-time.After(poll):
		}
		if !e.current(gen) {
			return
		}
		if addrInUse(e.address()) && e.healthy() {
			continue
		}
		log.Printf("[embed] the embedding server GobboNet did not start has gone; starting GobboNet's own")
		e.bringUp(gen)
		return
	}
}

// current reports whether gen is still the generation that should be running.
func (e *Embedder) current(gen uint64) bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return !e.closed && e.want && !e.standby && e.gen == gen
}

func (e *Embedder) healthy() bool {
	resp, err := e.client.Get("http://" + e.address() + "/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// waitHealthy polls /health until it answers. It gives up at once when the
// child dies, and when the generation moves on (a stand-down or shutdown must
// not wait out a load).
func (e *Embedder) waitHealthy(gen uint64, exited <-chan struct{}) error {
	timeout := e.opts.LoadTimeout
	if timeout <= 0 {
		timeout = embedLoadTimeout
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-exited:
			if f := e.stderr.failure(); f != nil && f.Line != "" {
				return fmt.Errorf("the embedding server stopped while starting: %s", f.Line)
			}
			return fmt.Errorf("the embedding server stopped while starting")
		case <-e.shutdown:
			return errSuperseded
		default:
		}
		if !e.current(gen) {
			return errSuperseded
		}
		if e.healthy() {
			return nil
		}
		time.Sleep(healthProbeInterval)
	}
	return fmt.Errorf("the embedding server did not answer within %s", timeout)
}

// stopLocked ends the child this Embedder started, if any. Caller holds opMu.
func (e *Embedder) stopLocked() error {
	e.mu.Lock()
	cmd, pgid, exited := e.cmd, e.pgid, e.exited
	e.mu.Unlock()
	if (cmd == nil || cmd.Process == nil) && pgid == 0 {
		return nil
	}
	if err := endTree(pgid, exited, cmd != nil && cmd.Process != nil, "[embed]", "the embedding server"); err != nil {
		return err
	}
	e.mu.Lock()
	e.cmd, e.pgid, e.exited = nil, 0, nil
	e.mu.Unlock()
	releaseTree(pgid)
	return waitAddrFree(e.address())
}

// StandDown stops the server with the chat model, to come back with it. A
// server GobboNet did not start, or one that is off or failed, is left alone.
func (e *Embedder) StandDown() {
	e.mu.Lock()
	state := e.status.State
	if e.closed || !e.want || e.standby || (state != EmbedRunning && state != EmbedStarting && state != EmbedRestarting) {
		e.mu.Unlock()
		return
	}
	e.standby = true
	e.gen++
	e.mu.Unlock()
	e.opMu.Lock()
	err := e.stopLocked()
	e.opMu.Unlock()
	if err != nil {
		log.Printf("[embed] stand-down cleanup: %v", err)
	}
	e.setStatus(EmbedStandby, "stood down with the chat model; it comes back on the next message")
	log.Printf("[embed] stood down with the chat model")
}

// Wake brings a stood-down server back in the background.
func (e *Embedder) Wake() {
	e.mu.Lock()
	if e.closed || !e.standby {
		e.mu.Unlock()
		return
	}
	e.standby = false
	e.gen++
	gen := e.gen
	e.status.State, e.status.Detail = EmbedStarting, ""
	e.mu.Unlock()
	go e.bringUp(gen)
}

// WakeAndWait wakes a stood-down server and waits up to within for it to
// answer, for a request that needs it now. Any other state returns at once.
func (e *Embedder) WakeAndWait(within time.Duration) {
	if e.Status().State != EmbedStandby {
		return
	}
	e.Wake()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		switch e.Status().State {
		case EmbedRunning, EmbedFailed, EmbedExternal, EmbedOff:
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
}

// Shutdown stops the server for good.
func (e *Embedder) Shutdown() {
	e.mu.Lock()
	if !e.closed {
		e.closed = true
		close(e.shutdown)
	}
	e.gen++
	e.mu.Unlock()
	e.opMu.Lock()
	defer e.opMu.Unlock()
	if err := e.stopLocked(); err != nil {
		log.Printf("[embed] shutdown cleanup: %v", err)
	}
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
