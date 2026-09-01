// Package jobs implements detached generation — the /llm/jobs* API.
//
// WHY THIS EXISTS: chat.html used to hold the /llm streaming fetch open in the
// browser for the whole generation. Any navigation — new URL in the tab, tab
// close, phone screen lock — tore down that fetch, the proxy connection to
// llama.cpp collapsed, and the server cancelled the slot. The reply died with
// the page. No browser mechanism can reliably keep a cross-navigation SSE stream
// alive: service workers get frozen too, and mobile OSes kill backgrounded
// sockets within seconds.
//
// So the long-lived connection moves HERE, into the one process that never
// navigates away.
//
//	POST   /llm/jobs                        body is the exact chat/completions
//	                                        request. Returns {id} immediately.
//	GET    /llm/jobs/{id}?from=N[&max=M]    new bytes from offset N
//	POST   /llm/jobs/{id}/cancel            abort the upstream request
//	DELETE /llm/jobs/{id}                   client ack; drops the buffer
//
// The client polls, feeds the bytes through the SAME parser pipeline it uses for
// live streaming, and can reattach after a navigation and replay from byte 0
// with identical results.
//
// Buffering raw SSE bytes rather than parsed text is deliberate: thinking-format
// splitting, tool-call unwrapping and reasoning-field routing all stay in
// chat.html where they already live. This package stays a dumb, faithful pipe.
//
// The wire contract belongs to fileserver.ps1, which defined it, and the stock
// frontend is written against that. Poll chunks go out base64-encoded as
// chunk_b64; job ids stay 32 lowercase hex; the status vocabulary is unchanged.
// Deviating buys nothing and costs compatibility with the one client there is.
//
// What DOES differ is storage, and only because nothing observable depends on
// it: everything is held in memory. The PowerShell original spools to .jobs/
// with cancel-flag files because a runspace cannot share state with the
// listener; a goroutine can, so cancellation is a context and the spool is a
// bytes.Buffer. At ~150 tok/s a thirty-minute generation is single-digit
// megabytes, and finished jobs are held only until the client acks or the
// retention window expires. The visible consequence is that a restart drops
// jobs entirely (the client sees 404 → 'lost') where PowerShell reports them
// 'interrupted'; both are terminal and the frontend handles each.
//
// A POST past the concurrency cap SUPERSEDES rather than queues or refuses —
// see supersede(). The app has always been one generation at a time, and the
// server now enforces that instead of permitting a backlog llama.cpp cannot
// serve.
package jobs

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/jmccardle/gobbonet/internal/httpx"
)

// Status values. done, cancelled, error and interrupted are terminal — the
// client stops polling when it sees one.
const (
	StatusRunning     = "running"
	StatusDone        = "done"
	StatusCancelled   = "cancelled"
	StatusError       = "error"
	StatusInterrupted = "interrupted"
)

var jobPathRe = regexp.MustCompile(`^/llm/jobs/([0-9a-f]{32})(/cancel)?$`)

const (
	// maxPollBytes bounds one poll response. The client drains in a tight loop
	// until next == size, so a long backlog clears in a few round trips.
	maxPollBytes = 262144

	// jobTimeout is the hard runtime cap for one generation. Generous — huge
	// contexts on big models can sit in prompt processing for minutes — but
	// finite, so a wedged upstream can't leave a job running forever.
	//
	// It is the outermost bound and deliberately not the only one. Thirty
	// minutes of a spinner is not meaningfully better than forever to someone
	// waiting on a reply, so the stages below catch the common wedges first.
	jobTimeout = 30 * time.Minute

	// dialTimeout is short: either the upstream is there or it isn't. Matches
	// internal/proxy.
	dialTimeout = 10 * time.Second

	// responseHeaderTimeout must clear the worst realistic prompt-processing
	// delay. A 40K-context prefill on a large model can run well past thirty
	// seconds before llama.cpp emits its first byte, and cutting that off looks
	// like a broken server rather than a busy one. Matches internal/proxy.
	//
	// This is the bound that catches the wedge this file previously had no
	// answer for: a socket that accepts and then says nothing — llama.cpp
	// deadlocked, a GPU hang, or a firewall dropping rather than rejecting.
	// http.Client.Timeout cannot express it, because that clock covers the
	// streaming body too.
	responseHeaderTimeout = 5 * time.Minute

	// idleTimeout bounds the gap BETWEEN chunks once a stream is flowing, not
	// the total duration. A long generation is healthy and may run for many
	// minutes; ten minutes of complete silence mid-stream is a dead upstream
	// that will never send its EOF. Matches internal/proxy.
	idleTimeout = 10 * time.Minute

	// maxJobBytes caps one job's buffer. A runaway upstream that never stops
	// emitting must not be able to exhaust memory.
	maxJobBytes = 128 << 20 // 128 MiB
)

// Why a job stopped, when the reason is ours rather than the caller's.
//
// These travel as context causes so the run loop can tell a watchdog trip from
// a user pressing stop. Both arrive as the same cancellation on the wire; only
// the cause distinguishes them, and reporting a timeout as "cancelled" would
// tell someone their own click stopped a generation they were waiting on.
var (
	errIdleUpstream = errors.New("upstream stopped sending mid-generation")
	errJobExpired   = errors.New("generation exceeded the maximum runtime")
)

// Job is one detached generation.
type Job struct {
	ID     string
	Thread string
	// seq is a monotonic creation order, used to shed the oldest work first.
	seq uint64

	mu        sync.Mutex
	buf       bytes.Buffer
	status    string
	errMsg    string
	startedAt int64
	updatedAt int64
	// finishedAt drives retention; zero while running.
	finishedAt time.Time

	cancel context.CancelFunc
	// done is closed when the worker goroutine returns, which is strictly after
	// the upstream response body has been closed. That ordering is the whole
	// value of the channel: a superseding request waits on it to know llama.cpp
	// has seen the disconnect and freed its slot, rather than dispatching into a
	// server that is still holding the previous connection.
	done chan struct{}
}

func (j *Job) snapshot() (status, errMsg string, size int, startedAt, updatedAt int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status, j.errMsg, j.buf.Len(), j.startedAt, j.updatedAt
}

// read returns the raw byte window [from, from+max) of the spool, exactly as
// fileserver.ps1's poll branch does.
//
// No character alignment, deliberately. An earlier revision nudged the window
// to a rune boundary because the chunk went out as a JSON string and Go turns
// an invalid UTF-8 byte into U+FFFD on encode. base64 has no such problem, and
// the client is decoding with `new TextDecoder().decode(bytes, {stream: true})`
// (js/03-generation.js, makeStreamFeeder), which reassembles characters split
// across chunk boundaries on its own.
//
// Alignment is worse than merely redundant now: it could not represent a window
// containing no complete character, so it returned an empty chunk and left
// `next` at `from`. Bytes that are not UTF-8 at all — which base64 would carry
// perfectly — would stall the offset forever while the job streamed on, i.e.
// the same silent infinite poll that sending the wrong field name causes.
func (j *Job) read(from, max int) (chunk []byte, size, next int) {
	j.mu.Lock()
	defer j.mu.Unlock()

	all := j.buf.Bytes()
	size = len(all)
	if from > size {
		from = size
	}
	if from == size || max <= 0 {
		return nil, size, from
	}

	end := from + max
	if end > size {
		end = size
	}
	return all[from:end], size, end
}

func (j *Job) setStatus(status, errMsg string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.status = status
	if errMsg != "" {
		j.errMsg = errMsg
	}
	j.updatedAt = time.Now().Unix()
	if status != StatusRunning {
		j.finishedAt = time.Now()
	}
}

func (j *Job) write(p []byte) (int, error) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.buf.Len()+len(p) > maxJobBytes {
		return 0, fmt.Errorf("generation exceeded %d bytes", maxJobBytes)
	}
	return j.buf.Write(p)
}

// Manager owns the live jobs.
type Manager struct {
	llmURL string
	apiKey string

	maxConcurrent int
	maxAge        time.Duration

	// idle is the tolerated gap between chunks once a stream is flowing, and
	// maxRuntime the outermost cap on one generation. Fields rather than
	// constants so tests can shrink them to observable lengths.
	idle       time.Duration
	maxRuntime time.Duration

	client *http.Client

	nextSeq atomic.Uint64

	mu   sync.Mutex
	jobs map[string]*Job
}

// newJobClient builds the streaming client with its dial and first-byte bounds.
//
// Separated from NewManager so tests can rebuild it with windows short enough
// to observe. A watchdog whose only proof is a five-minute test is a watchdog
// nobody runs.
func newJobClient(dial, header time.Duration) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: (&net.Dialer{
				Timeout:   dial,
				KeepAlive: 30 * time.Second,
			}).DialContext,
			ResponseHeaderTimeout: header,
			IdleConnTimeout:       90 * time.Second,
			// The stream is SSE and uncompressed; asking for gzip would only
			// add work and defeat incremental reads.
			DisableCompression: true,
			ForceAttemptHTTP2:  false,
		},
	}
}

func NewManager(llmURL, apiKey string, maxConcurrent, maxAgeHours int) *Manager {
	return &Manager{
		llmURL:        llmURL,
		apiKey:        apiKey,
		maxConcurrent: maxConcurrent,
		maxAge:        time.Duration(maxAgeHours) * time.Hour,
		idle:          idleTimeout,
		maxRuntime:    jobTimeout,
		// No overall client timeout: a generation legitimately runs for a long
		// time, and http.Client.Timeout covers the whole request INCLUDING the
		// streaming body read, so any value large enough for a long generation
		// is too large to catch a wedged upstream.
		//
		// The bounds are staged instead, matching internal/proxy: a short dial,
		// a generous wait for the first byte, and a watchdog on the gap between
		// chunks (see run). maxRuntime remains the outermost cap.
		client: newJobClient(dialTimeout, responseHeaderTimeout),
		jobs:   make(map[string]*Job),
	}
}

// Shutdown cancels every running job. On restart they would have been reported
// as interrupted anyway; cancelling explicitly frees the upstream slots.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, j := range m.jobs {
		j.mu.Lock()
		running := j.status == StatusRunning
		j.mu.Unlock()
		if running && j.cancel != nil {
			j.cancel()
			j.setStatus(StatusInterrupted, "server shutting down mid-generation")
		}
	}
}

// sweep drops finished jobs past the retention window.
func (m *Manager) sweep() {
	cutoff := time.Now().Add(-m.maxAge)
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, j := range m.jobs {
		j.mu.Lock()
		expired := !j.finishedAt.IsZero() && j.finishedAt.Before(cutoff)
		j.mu.Unlock()
		if expired {
			delete(m.jobs, id)
		}
	}
}

func (m *Manager) runningCount() int {
	return len(m.running())
}

// running lists the live jobs, oldest first. Ordering matters to supersede,
// which sheds the longest-running work when it has to choose.
func (m *Manager) running() []*Job {
	m.mu.Lock()
	defer m.mu.Unlock()

	var live []*Job
	for _, j := range m.jobs {
		j.mu.Lock()
		if j.status == StatusRunning {
			live = append(live, j)
		}
		j.mu.Unlock()
	}
	sort.Slice(live, func(a, b int) bool { return live[a].seq < live[b].seq })
	return live
}

// supersedeTimeout bounds the wait for a cancelled generation to let go of its
// upstream socket.
//
// Upstream's equivalent is 2.5s, chosen because PowerShell's accept loop is
// single-threaded and the whole server stalls for the duration. Nothing else is
// blocked here — only the goroutine serving this one POST — so the bound is
// picked from what it is actually waiting for: an HTTP connection teardown,
// which is milliseconds when it works at all. Five seconds is long enough that
// reaching it means something is genuinely wrong, and short enough that the
// user still gets an answer either way.
const supersedeTimeout = 5 * time.Second

// supersede makes room for a new generation by cancelling the oldest live ones,
// and waits for them to actually let go.
//
// This replaces a 429. Both halves of that answer were wrong. llama-server runs
// one slot, so a cap of four only bought a queue it could not serve: press Stop,
// send again, and the new request sat behind a generation nobody was reading
// because llama-server had not noticed the disconnect yet. Do it a few more
// times and four stacked generations fought over one slot until they drained.
// And a refusal is not what someone who just pressed Send wants — they plainly
// want the new generation and not the old one.
//
// The wait is the part that matters. Cancelling and dispatching immediately
// would put the new request in the queue behind a connection llama.cpp has not
// finished tearing down, which is precisely the stall this removes.
//
// Returns false if the wait ran out. The caller dispatches anyway: the contexts
// are cancelled and those goroutines are dying, and refusing the user's
// generation on top of a slow teardown helps nobody.
func (m *Manager) supersede() bool {
	live := m.running()
	surplus := len(live) - m.maxConcurrent + 1
	if surplus <= 0 {
		return true
	}
	if surplus > len(live) {
		surplus = len(live)
	}
	shed := live[:surplus]

	for _, j := range shed {
		j.mu.Lock()
		cancel := j.cancel
		j.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		log.Printf("[jobs] superseding %s -- a new generation was requested", j.ID)
	}

	deadline := time.After(supersedeTimeout)
	for _, j := range shed {
		select {
		case <-j.done:
		case <-deadline:
			log.Printf("[jobs] %s did not release its upstream connection within %s; dispatching anyway",
				j.ID, supersedeTimeout)
			return false
		}
	}
	return true
}

func (m *Manager) get(id string) (*Job, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	j, ok := m.jobs[id]
	return j, ok
}

func newJobID() (string, error) {
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw), nil
}

// --- Worker ----------------------------------------------------------------

func (m *Manager) run(ctx context.Context, job *Job, body []byte) {
	// Registered first, so it runs last — after the deferred resp.Body.Close()
	// below. Whoever is waiting on done needs the socket gone, not merely the
	// context cancelled.
	defer close(job.done)
	defer func() {
		job.mu.Lock()
		cancel := job.cancel
		job.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	}()

	// The stall context must wrap the request, not just the read loop. It is
	// created here, before the request is built, because cancelling a context
	// the request was not made with does nothing at all: the socket stays open
	// and Read goes on blocking. An earlier arrangement of this had the
	// watchdog firing correctly into the void.
	ctx, stalled := context.WithCancelCause(ctx)
	defer stalled(nil)

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.llmURL+"/v1/chat/completions", bytes.NewReader(body))
	if err != nil {
		job.setStatus(StatusError, err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if m.apiKey != "" {
		req.Header.Set("Authorization", "Bearer "+m.apiKey)
	}

	resp, err := m.client.Do(req)
	if err != nil {
		status, msg := m.terminalFailure(ctx, err)
		job.setStatus(status, msg)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		// Surface llama.cpp's own error body — far more actionable than a
		// generic failure.
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := fmt.Sprintf("upstream HTTP %d", resp.StatusCode)
		if len(detail) > 0 {
			msg += ": " + string(detail)
		}
		job.setStatus(StatusError, msg)
		return
	}

	// From here the response headers have arrived, so ResponseHeaderTimeout is
	// spent and nothing else bounds the wait between chunks. A stream that
	// stops mid-generation — llama.cpp crashing, a GPU hang, a dropped route —
	// leaves Read blocked with no error to report, which is the shape of hang
	// this whole path exists to prevent. The watchdog starts only now, so a
	// long prompt-processing pause before the first byte is not mistaken for a
	// stalled stream.
	progress := newProgressClock()
	go watchForStall(ctx, progress, m.idle, stalled)

	buf := make([]byte, 8192)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			progress.mark()
			if _, err := job.write(buf[:n]); err != nil {
				job.setStatus(StatusError, err.Error())
				return
			}
		}
		if readErr != nil {
			if readErr == io.EOF {
				job.setStatus(StatusDone, "")
				return
			}
			// A cancelled context surfaces here as a read error on the closed
			// connection; report the cause, not the symptom.
			status, msg := m.terminalFailure(ctx, readErr)
			job.setStatus(status, msg)
			return
		}
	}
}

// terminalFailure decides what a failed request or read means to the person
// waiting on it.
//
// The context's cause is consulted before its error, because every one of these
// arrives as the same cancellation at the socket. Only the cause separates "you
// pressed stop" from "we gave up on a silent upstream", and the previous
// version of this code reported both as "cancelled" — which told a user their
// own click had stopped a generation that in fact died on its own, and left the
// real failure unrecorded anywhere.
func (m *Manager) terminalFailure(ctx context.Context, err error) (status, message string) {
	switch cause := context.Cause(ctx); {
	case errors.Is(cause, errIdleUpstream):
		return StatusError, fmt.Sprintf(
			"the model server stopped sending after %s. It may have crashed or run out of memory -- check the llama-server log.",
			m.idle)

	case errors.Is(cause, errJobExpired):
		return StatusError, fmt.Sprintf(
			"this generation ran past the %s limit and was stopped.", m.maxRuntime)

	case ctx.Err() != nil:
		// A plain cancellation: the caller asked for it.
		return StatusCancelled, ""
	}
	return StatusError, err.Error()
}

// progressClock records when the stream last moved.
type progressClock struct{ last atomic.Int64 }

func newProgressClock() *progressClock {
	p := &progressClock{}
	p.mark()
	return p
}

func (p *progressClock) mark() { p.last.Store(time.Now().UnixNano()) }

func (p *progressClock) idleFor() time.Duration {
	return time.Since(time.Unix(0, p.last.Load()))
}

// watchForStall cancels the stream when nothing has arrived for idleTimeout.
//
// It ticks rather than sleeping for the full window so that a stall is noticed
// within a quarter of it, and exits with the context so a healthy job does not
// leave a goroutine behind.
func watchForStall(ctx context.Context, p *progressClock, idle time.Duration, stalled context.CancelCauseFunc) {
	t := time.NewTicker(idle / 4)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if p.idleFor() >= idle {
				stalled(errIdleUpstream)
				return
			}
		}
	}
}

// --- HTTP ------------------------------------------------------------------

// Handle serves every /llm/jobs* route.
func (m *Manager) Handle(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Path

	if path == "/llm/jobs" {
		m.handleCreate(w, r)
		return
	}

	match := jobPathRe.FindStringSubmatch(path)
	if match == nil {
		httpx.WriteJSON(w, r, http.StatusNotFound, map[string]string{
			"error": "bad jobs path",
			"path":  path,
		})
		return
	}

	id, isCancel := match[1], match[2] != ""
	job, ok := m.get(id)
	if !ok {
		httpx.WriteJSON(w, r, http.StatusNotFound, map[string]string{
			"error": "unknown job",
			"id":    id,
		})
		return
	}

	switch {
	case isCancel:
		m.handleCancel(w, r, job)
	case r.Method == http.MethodDelete:
		m.handleDelete(w, r, job)
	case r.Method == http.MethodGet || r.Method == http.MethodHead:
		m.handlePoll(w, r, job)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET, POST /cancel, or DELETE")
	}
}

func (m *Manager) handleCreate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}

	m.sweep()

	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	if !json.Valid(body) {
		httpx.Error(w, r, http.StatusBadRequest, "body is not valid JSON")
		return
	}

	// After the body is known good, not before: a malformed request must not be
	// able to kill a generation the user is actually reading. Upstream sheds
	// first and parses second, which makes a client bug destructive.
	m.supersede()

	id, err := newJobID()
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "could not allocate job id", err.Error())
		return
	}

	// Optional ?thread=<id> rides along in the status. Purely informational —
	// the request body stays a byte-exact payload.
	now := time.Now().Unix()
	job := &Job{
		ID:     id,
		Thread: r.URL.Query().Get("thread"),
		// seq, not startedAt, orders jobs for supersede: startedAt is unix
		// seconds and two generations started in the same second would sort
		// arbitrarily, which at a cap above 1 could shed the newer one.
		seq:       m.nextSeq.Add(1),
		status:    StatusRunning,
		startedAt: now,
		updatedAt: now,
		done:      make(chan struct{}),
	}

	// WithTimeoutCause, not WithTimeout: hitting the cap is a failure the user
	// needs told about, and without a cause it is indistinguishable at the
	// socket from them pressing stop.
	ctx, cancel := context.WithTimeoutCause(context.Background(), m.maxRuntime, errJobExpired)
	job.cancel = cancel

	// Register before starting the worker: a poll landing one millisecond after
	// the 202 must find the job.
	m.mu.Lock()
	m.jobs[id] = job
	m.mu.Unlock()

	go m.run(ctx, job, body)

	log.Printf("[jobs] started %s (thread=%q, %d bytes of request)", id, job.Thread, len(body))
	httpx.WriteJSON(w, r, http.StatusAccepted, map[string]string{
		"id":     id,
		"status": StatusRunning,
	})
}

func (m *Manager) handleCancel(w http.ResponseWriter, r *http.Request, job *Job) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}
	// Cancelling the context aborts the upstream request, which frees the
	// llama.cpp slot immediately rather than at the end of the generation.
	job.mu.Lock()
	cancel := job.cancel
	job.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	log.Printf("[jobs] cancel requested: %s", job.ID)
	httpx.WriteJSON(w, r, http.StatusOK, map[string]string{
		"id":     job.ID,
		"status": "cancelling",
	})
}

func (m *Manager) handleDelete(w http.ResponseWriter, r *http.Request, job *Job) {
	status, _, _, _, _ := job.snapshot()
	if status == StatusRunning {
		// Ack for a live job: cancel and let the worker wind down. The retention
		// sweep (or a later DELETE) collects it.
		job.mu.Lock()
		cancel := job.cancel
		job.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		httpx.WriteJSON(w, r, http.StatusAccepted, map[string]string{
			"id":     job.ID,
			"status": "cancelling",
		})
		return
	}

	m.mu.Lock()
	delete(m.jobs, job.ID)
	m.mu.Unlock()

	httpx.WriteJSON(w, r, http.StatusOK, map[string]string{
		"id":     job.ID,
		"status": "deleted",
	})
}

func (m *Manager) handlePoll(w http.ResponseWriter, r *http.Request, job *Job) {
	from := intParam(r, "from", 0)
	if from < 0 {
		from = 0
	}
	max := intParam(r, "max", maxPollBytes)
	if max < 0 {
		max = 0
	}
	if max > maxPollBytes {
		max = maxPollBytes
	}

	chunk, size, next := job.read(from, max)
	status, errMsg, _, startedAt, updatedAt := job.snapshot()

	out := map[string]any{
		"id":     job.ID,
		"status": status,
		"size":   size,
		"next":   next,
	}

	if len(chunk) > 0 {
		// base64, and NOT a plain JSON string, because chunk_b64 is the wire
		// contract fileserver.ps1 defined and the stock frontend is the only
		// client: js/03-generation.js reads j.chunk_b64 and nothing else.
		//
		// Sending UTF-8 directly does save the 33% base64 overhead, and an
		// earlier revision of this file did exactly that. Do not restore it.
		// The frontend does not error on an unknown payload shape — it sees no
		// chunk_b64, leaves `offset` where it was, computes drained = offset >=
		// size as false, and polls forever against a job that is streaming
		// perfectly well. The reply never appears and nothing is logged
		// anywhere. A wire-format opinion is not worth a silent hang.
		out["chunk_b64"] = base64.StdEncoding.EncodeToString(chunk)
	}

	if errMsg != "" {
		out["error"] = errMsg
	}
	// started_at is set at creation; updated_at is stamped when the worker
	// records the terminal status — so (updated_at - started_at) is the
	// generation's true duration even for replies that finished while no tab
	// was attached.
	if startedAt != 0 {
		out["started_at"] = startedAt
	}
	if updatedAt != 0 {
		out["updated_at"] = updatedAt
	}

	httpx.WriteJSON(w, r, http.StatusOK, out)
}

func intParam(r *http.Request, name string, def int) int {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return def
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	return n
}
