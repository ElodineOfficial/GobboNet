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
// Everything is held in memory. The Python port spooled to disk with cancel-flag
// files and base64 poll framing because CPython's threading and JSON pushed it
// there; none of that applies here. At ~150 tok/s a thirty-minute generation is
// single-digit megabytes, and four concurrent jobs is tens of megabytes.
// Cancellation is a context, not a file.
package jobs

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

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
	jobTimeout = 30 * time.Minute

	// maxJobBytes caps one job's buffer. A runaway upstream that never stops
	// emitting must not be able to exhaust memory.
	maxJobBytes = 128 << 20 // 128 MiB
)

// Job is one detached generation.
type Job struct {
	ID     string
	Thread string

	mu        sync.Mutex
	buf       bytes.Buffer
	status    string
	errMsg    string
	startedAt int64
	updatedAt int64
	// finishedAt drives retention; zero while running.
	finishedAt time.Time

	cancel context.CancelFunc
}

func (j *Job) snapshot() (status, errMsg string, size int, startedAt, updatedAt int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.status, j.errMsg, j.buf.Len(), j.startedAt, j.updatedAt
}

// read returns a rune-aligned window of up to ~max bytes starting at from.
//
// Alignment is the whole job here. The poll protocol counts BYTES, but the wire
// format is now a JSON string rather than base64, and Go turns an invalid UTF-8
// byte into U+FFFD on encode — silently corrupting the stream at every chunk
// boundary that lands inside a multi-byte character.
//
// So the window end is nudged to a character boundary. It moves FORWARD when the
// completing bytes have already arrived, which guarantees progress even when max
// is smaller than a single character. It only trims backward when the tail
// character genuinely hasn't been received yet, in which case the next poll
// picks it up whole.
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

	// Extend forward over an incomplete trailing character. Bounded by
	// utf8.UTFMax, so this can overshoot max by at most three bytes.
	for end < size && end-from < max+utf8.UTFMax && !utf8.Valid(all[from:end]) {
		end++
	}

	chunk = all[from:end]
	if !utf8.Valid(chunk) {
		// The completing bytes are still in flight. Hand back whole characters
		// only and let the remainder arrive on the next poll.
		chunk = trimToRuneBoundary(chunk)
		end = from + len(chunk)
	}
	return chunk, size, end
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

	client *http.Client

	mu   sync.Mutex
	jobs map[string]*Job
}

func NewManager(llmURL, apiKey string, maxConcurrent, maxAgeHours int) *Manager {
	return &Manager{
		llmURL:        llmURL,
		apiKey:        apiKey,
		maxConcurrent: maxConcurrent,
		maxAge:        time.Duration(maxAgeHours) * time.Hour,
		// No client timeout: a generation legitimately runs for a long time.
		// The per-job context carries jobTimeout instead.
		client: &http.Client{},
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
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, j := range m.jobs {
		j.mu.Lock()
		if j.status == StatusRunning {
			n++
		}
		j.mu.Unlock()
	}
	return n
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
	defer func() {
		job.mu.Lock()
		cancel := job.cancel
		job.mu.Unlock()
		if cancel != nil {
			cancel()
		}
	}()

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
		if ctx.Err() != nil {
			job.setStatus(StatusCancelled, "")
		} else {
			job.setStatus(StatusError, err.Error())
		}
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

	buf := make([]byte, 8192)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
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
			if ctx.Err() != nil {
				job.setStatus(StatusCancelled, "")
			} else {
				job.setStatus(StatusError, readErr.Error())
			}
			return
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

	// Concurrency cap. A single-slot llama.cpp queues extras anyway; this just
	// stops a misbehaving client from stacking workers.
	if live := m.runningCount(); live >= m.maxConcurrent {
		httpx.Error(w, r, http.StatusTooManyRequests,
			fmt.Sprintf("too many generations in flight (%d); try again shortly", live))
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	if !json.Valid(body) {
		httpx.Error(w, r, http.StatusBadRequest, "body is not valid JSON")
		return
	}

	id, err := newJobID()
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "could not allocate job id", err.Error())
		return
	}

	// Optional ?thread=<id> rides along in the status. Purely informational —
	// the request body stays a byte-exact payload.
	now := time.Now().Unix()
	job := &Job{
		ID:        id,
		Thread:    r.URL.Query().Get("thread"),
		status:    StatusRunning,
		startedAt: now,
		updatedAt: now,
	}

	ctx, cancel := context.WithTimeout(context.Background(), jobTimeout)
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
		// SSE payloads are UTF-8, so a JSON string carries them directly — no
		// base64, which cost 33% of the bandwidth for nothing. job.read has
		// already aligned the window to character boundaries, so `chunk`
		// re-encodes to exactly (next - from) bytes on the client.
		out["chunk"] = string(chunk)
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

// trimToRuneBoundary drops a trailing partial UTF-8 sequence.
//
// The bound runs to len(b) inclusive, so a slice that is nothing but a partial
// character correctly trims to empty. Stopping short of that was a real bug: a
// lone continuation byte survived, and string() turned it into U+FFFD.
func trimToRuneBoundary(b []byte) []byte {
	if utf8.Valid(b) {
		return b
	}
	// A UTF-8 sequence is at most 4 bytes, so the truncation point is within
	// the last three.
	for i := 1; i <= utf8.UTFMax-1 && i <= len(b); i++ {
		if utf8.Valid(b[:len(b)-i]) {
			return b[:len(b)-i]
		}
	}
	// Invalid somewhere other than the tail: the upstream sent bytes that are
	// not UTF-8 at all. Nothing here can be framed safely.
	return nil
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
