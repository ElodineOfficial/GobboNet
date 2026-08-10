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
// megabytes, and four concurrent jobs is tens of megabytes. The visible
// consequence is that a restart drops jobs entirely (the client sees 404 →
// 'lost') where PowerShell reports them 'interrupted'; both are terminal and
// the frontend handles each.
package jobs

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
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
