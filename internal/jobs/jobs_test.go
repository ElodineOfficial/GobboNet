package jobs

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// read hands back a raw byte window and must ALWAYS advance `next`, whatever
// the bytes are. The predecessor to this test guarded rune alignment, which
// base64 framing made unnecessary; what matters now is the property that
// replaced it. A window that cannot advance is not a corrupt character, it is a
// client polling a healthy job forever with nothing to show for it.
func TestReadAdvancesOverArbitraryBytes(t *testing.T) {
	// Deliberately not UTF-8: a lone continuation byte, a truncated 3-byte
	// sequence, and a 0xFF that can never appear in valid UTF-8 at all.
	body := []byte("data: ok\n\x80\xe2\x82\xff\xfe binary tail")
	job := &Job{ID: "x", status: StatusRunning}
	if _, err := job.write(body); err != nil {
		t.Fatal(err)
	}

	// Drain one byte at a time — the tightest window a client can ask for, and
	// the one most likely to land mid-character.
	var assembled []byte
	offset := 0
	for i := 0; i < len(body)+8; i++ {
		chunk, size, next := job.read(offset, 1)
		if offset >= size {
			break
		}
		if next <= offset {
			t.Fatalf("read stalled at offset %d of %d (chunk %q)", offset, size, chunk)
		}
		if len(chunk) != next-offset {
			t.Fatalf("chunk is %d bytes but next advanced by %d", len(chunk), next-offset)
		}
		assembled = append(assembled, chunk...)
		offset = next
	}

	if !bytes.Equal(assembled, body) {
		t.Errorf("reassembled bytes differ:\n got %q\nwant %q", assembled, body)
	}

	// And the framing must survive the encoding the poll response actually uses.
	if got, err := base64.StdEncoding.DecodeString(
		base64.StdEncoding.EncodeToString(body)); err != nil || !bytes.Equal(got, body) {
		t.Errorf("base64 round-trip altered the bytes: %q (err %v)", got, err)
	}
}

// The offsets a client sends back must line up with the bytes it received, or
// the stream desynchronises and tokens are dropped or repeated.
func TestPollOffsetsAreByteExact(t *testing.T) {
	job := &Job{ID: "x", status: StatusRunning}
	body := "data: {\"content\":\"héllo→ world\"}\n\n"
	if _, err := job.write([]byte(body)); err != nil {
		t.Fatal(err)
	}

	// Walk the buffer in windows, as a client draining a backlog does, and
	// reassemble. Every window size must produce the original bytes exactly.
	//
	// max=1 and max=2 are the cases that matter: they are narrower than the
	// multi-byte characters in the payload, so they split those characters
	// across polls. That is fine and expected — base64 carries the fragments
	// intact and the client's TextDecoder rejoins them — but it is exactly
	// where an off-by-one in the offset bookkeeping would hide.
	for _, window := range []int{1, 2, 3, 4, 7, maxPollBytes} {
		var assembled []byte
		offset := 0
		for i := 0; i < 5000; i++ {
			chunk, size, next := job.read(offset, window)
			if offset >= size {
				break
			}
			if len(chunk) == 0 {
				t.Fatalf("window %d: no progress at offset %d of %d", window, offset, size)
			}
			// What the client receives is base64; decoding it must yield
			// exactly the bytes the offset advanced by.
			decoded, err := base64.StdEncoding.DecodeString(base64.StdEncoding.EncodeToString(chunk))
			if err != nil {
				t.Fatalf("window %d: chunk did not survive base64: %v", window, err)
			}
			if len(decoded) != next-offset {
				t.Fatalf("window %d: chunk decodes to %d bytes but next advanced %d",
					window, len(decoded), next-offset)
			}
			assembled = append(assembled, decoded...)
			offset = next
		}
		if string(assembled) != body {
			t.Errorf("window %d: reassembled stream differs:\n got %q\nwant %q", window, assembled, body)
		}
	}
}

// Awkward multi-byte payloads reassemble byte-exactly at every window size.
// This used to assert that each chunk survived a JSON round trip unchanged --
// the invariant base64 provides for free, and which only had to be tested
// because an earlier revision framed chunks as plain JSON strings. With
// chunk_b64 restored, what is worth pinning is that the offsets stay exact
// across characters wide enough to be split several ways.
func TestPollReassemblesWideCharacters(t *testing.T) {
	job := &Job{ID: "x", status: StatusRunning}
	// Deliberately awkward: 2-byte, 3-byte and 4-byte characters back to back.
	body := "data: {\"c\":\"éñ→𝄞漢字\"}\n\n"
	if _, err := job.write([]byte(body)); err != nil {
		t.Fatal(err)
	}

	for window := 1; window <= 12; window++ {
		var assembled []byte
		offset := 0
		for i := 0; i < 5000; i++ {
			chunk, size, next := job.read(offset, window)
			if offset >= size {
				break
			}
			if len(chunk) == 0 {
				t.Fatalf("window %d: stalled at offset %d", window, offset)
			}
			decoded, err := base64.StdEncoding.DecodeString(base64.StdEncoding.EncodeToString(chunk))
			if err != nil {
				t.Fatalf("window %d: chunk did not survive base64: %v", window, err)
			}
			if len(decoded) != next-offset {
				t.Fatalf("window %d: decoded %d bytes but offset advanced %d", window, len(decoded), next-offset)
			}
			assembled = append(assembled, decoded...)
			offset = next
		}
		if string(assembled) != body {
			t.Errorf("window %d: got %q, want %q", window, assembled, body)
		}
	}
}

// End-to-end against a real SSE upstream: create, poll to completion, and
// confirm the client can rebuild the exact byte stream from `chunk`.
func TestJobStreamsFromUpstream(t *testing.T) {
	const reply = "data: {\"choices\":[{\"delta\":{\"content\":\"héllo\"}}]}\n\n" +
		"data: {\"choices\":[{\"delta\":{\"content\":\" wörld→\"}}]}\n\n" +
		"data: [DONE]\n\n"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("upstream path: got %q, want /v1/chat/completions", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sk-test" {
			t.Errorf("upstream Authorization: got %q, want the injected key", got)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		// Write in pieces so the job buffer genuinely accumulates over time.
		for _, part := range strings.Split(reply, "\n\n") {
			if part == "" {
				continue
			}
			fmt.Fprint(w, part+"\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(2 * time.Millisecond)
		}
	}))
	defer upstream.Close()

	m := NewManager(upstream.URL, "sk-test", 4, 48)

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/llm/jobs?thread=t7", strings.NewReader(`{"messages":[]}`))
	m.Handle(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("create: got %d, want 202 (%s)", rec.Code, rec.Body)
	}
	var created struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}

	// Poll exactly as js/03-generation.js does: decode `chunk_b64`, advance to
	// `next`, stop on a terminal status once drained.
	var assembled []byte
	offset := 0
	var status string
	deadline := time.Now().Add(10 * time.Second)

	for time.Now().Before(deadline) {
		rec = httptest.NewRecorder()
		req = httptest.NewRequest(http.MethodGet, fmt.Sprintf("/llm/jobs/%s?from=%d", created.ID, offset), nil)
		m.Handle(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("poll: got %d, want 200 (%s)", rec.Code, rec.Body)
		}

		var poll struct {
			Status   string `json:"status"`
			Size     int    `json:"size"`
			Next     int    `json:"next"`
			ChunkB64 string `json:"chunk_b64"`
			Error    string `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &poll); err != nil {
			t.Fatal(err)
		}
		if poll.ChunkB64 != "" {
			decoded, err := base64.StdEncoding.DecodeString(poll.ChunkB64)
			if err != nil {
				t.Fatalf("chunk_b64 is not valid base64: %v", err)
			}
			// The byte length of what arrived must equal the offset advance,
			// or a resume from `next` would skip or repeat bytes.
			if len(decoded) != poll.Next-offset {
				t.Fatalf("chunk decodes to %d bytes but next advanced by %d", len(decoded), poll.Next-offset)
			}
			assembled = append(assembled, decoded...)
			offset = poll.Next
		}
		status = poll.Status
		if status != StatusRunning && offset >= poll.Size {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}

	if status != StatusDone {
		t.Fatalf("final status: got %q, want done", status)
	}
	if string(assembled) != reply {
		t.Errorf("reassembled SSE differs:\n got %q\nwant %q", assembled, reply)
	}
}

// A cancel must free the upstream slot promptly rather than waiting for the
// generation to finish on its own.
func TestJobCancelStopsUpstream(t *testing.T) {
	released := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for i := 0; i < 2000; i++ {
			select {
			case <-r.Context().Done():
				close(released)
				return
			default:
			}
			fmt.Fprint(w, "data: {\"tick\":1}\n\n")
			if flusher != nil {
				flusher.Flush()
			}
			time.Sleep(5 * time.Millisecond)
		}
	}))
	defer upstream.Close()

	m := NewManager(upstream.URL, "", 4, 48)

	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs", strings.NewReader(`{}`)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create: got %d, want 202", rec.Code)
	}
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)

	// Let some bytes flow, then cancel.
	time.Sleep(50 * time.Millisecond)
	rec = httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs/"+created.ID+"/cancel", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel: got %d, want 200", rec.Code)
	}

	select {
	case <-released:
	case <-time.After(5 * time.Second):
		t.Fatal("the upstream request was never cancelled -- the llama.cpp slot would stay held")
	}

	// The job must settle on a terminal status, not linger at running.
	job, ok := m.get(created.ID)
	if !ok {
		t.Fatal("job disappeared")
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if status, _, _, _, _ := job.snapshot(); status != StatusRunning {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("job never reached a terminal status after cancel")
}

// blockingUpstream is a generation that never finishes on its own, so a job
// stays running until something cancels it.
//
// The handler must be releasable on demand as well as by the request context: a
// handler that only waits on the context never returns if it has written
// nothing, and httptest.Close then blocks forever waiting for it.
func blockingUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) }) // runs before srv.Close()
	return srv
}

func createJob(t *testing.T, m *Manager) (string, int) {
	t.Helper()
	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs", strings.NewReader(`{}`)))
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)
	return created.ID, rec.Code
}

// Past the cap, a new generation supersedes the running one instead of being
// refused. A 429 to someone who just pressed Send is a refusal, when what they
// plainly want is the new generation and not the old one.
func TestJobSupersedesInsteadOf429(t *testing.T) {
	upstream := blockingUpstream(t)
	m := NewManager(upstream.URL, "", 1, 48)
	defer m.Shutdown()

	firstID, code := createJob(t, m)
	if code != http.StatusAccepted {
		t.Fatalf("first job: got %d, want 202", code)
	}
	waitForStatus(t, m, firstID, StatusRunning)

	secondID, code := createJob(t, m)
	if code != http.StatusAccepted {
		t.Fatalf("second job past a cap of 1: got %d, want 202 (it must supersede, not be refused)", code)
	}
	if secondID == "" {
		t.Fatal("second job got no id")
	}

	// The superseded job is terminal, so the client polling it stops rather
	// than waiting on bytes that will never come.
	waitForStatus(t, m, firstID, StatusCancelled)

	// And the new one is genuinely running, not shed along with the old.
	waitForStatus(t, m, secondID, StatusRunning)
}

// The wait is the point. Dispatching the moment the context is cancelled would
// put the new request behind a connection llama.cpp has not finished tearing
// down — the exact stall this replaces. supersede must not return until the
// worker has actually let go.
func TestSupersedeWaitsForTheConnectionToClose(t *testing.T) {
	upstream := blockingUpstream(t)
	m := NewManager(upstream.URL, "", 1, 48)
	defer m.Shutdown()

	firstID, _ := createJob(t, m)
	waitForStatus(t, m, firstID, StatusRunning)

	first, ok := m.get(firstID)
	if !ok {
		t.Fatal("job disappeared")
	}

	if !m.supersede() {
		t.Error("supersede timed out against a well-behaved worker")
	}

	select {
	case <-first.done:
	default:
		t.Error("supersede returned while the worker was still holding its upstream connection")
	}
}

// Only enough work is shed to get under the cap, and it is the oldest that
// goes. At the default cap of 1 this is upstream's behaviour exactly; above it,
// shedding everything would throw away generations that had room to run.
func TestSupersedeShedsOldestFirst(t *testing.T) {
	upstream := blockingUpstream(t)
	m := NewManager(upstream.URL, "", 2, 48)
	defer m.Shutdown()

	oldest, _ := createJob(t, m)
	waitForStatus(t, m, oldest, StatusRunning)
	newer, _ := createJob(t, m)
	waitForStatus(t, m, newer, StatusRunning)

	// Both fit under a cap of 2, so neither may have been touched.
	if status, _, _, _, _ := mustGet(t, m, oldest).snapshot(); status != StatusRunning {
		t.Fatalf("a job within the cap was shed: %s", status)
	}

	third, code := createJob(t, m)
	if code != http.StatusAccepted {
		t.Fatalf("third job: got %d, want 202", code)
	}

	waitForStatus(t, m, oldest, StatusCancelled)
	if status, _, _, _, _ := mustGet(t, m, newer).snapshot(); status != StatusRunning {
		t.Errorf("the newer job was shed too: got %q, want it left running", status)
	}
	waitForStatus(t, m, third, StatusRunning)
}

// A client bug must not be able to kill a generation the user is reading.
// Upstream sheds first and parses second, which makes malformed JSON
// destructive; here the body is validated first.
func TestBadRequestDoesNotSupersede(t *testing.T) {
	upstream := blockingUpstream(t)
	m := NewManager(upstream.URL, "", 1, 48)
	defer m.Shutdown()

	firstID, _ := createJob(t, m)
	waitForStatus(t, m, firstID, StatusRunning)

	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs", strings.NewReader(`not json`)))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("malformed create: got %d, want 400", rec.Code)
	}

	// Give a wrongly-placed supersede time to land before checking.
	time.Sleep(100 * time.Millisecond)
	if status, _, _, _, _ := mustGet(t, m, firstID).snapshot(); status != StatusRunning {
		t.Errorf("a rejected request killed the live generation: status is %q", status)
	}
}

func mustGet(t *testing.T, m *Manager, id string) *Job {
	t.Helper()
	j, ok := m.get(id)
	if !ok {
		t.Fatalf("job %s disappeared", id)
	}
	return j
}

func waitForStatus(t *testing.T, m *Manager, id, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	var last string
	for time.Now().Before(deadline) {
		last, _, _, _, _ = mustGet(t, m, id).snapshot()
		if last == want {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s: status is %q, waited for %q", id, last, want)
}

// A job must reach a terminal status when the upstream rejects the request,
// carrying llama.cpp's own error body — far more actionable than a generic one.
func TestJobSurfacesUpstreamError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"message":"context length exceeded"}}`)
	}))
	defer upstream.Close()

	m := NewManager(upstream.URL, "", 4, 48)

	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs", strings.NewReader(`{}`)))
	var created struct {
		ID string `json:"id"`
	}
	json.Unmarshal(rec.Body.Bytes(), &created)

	job, _ := m.get(created.ID)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, errMsg, _, _, _ := job.snapshot()
		if status == StatusError {
			if !strings.Contains(errMsg, "context length exceeded") {
				t.Errorf("error message lost the upstream detail: %q", errMsg)
			}
			return
		}
		if status != StatusRunning {
			t.Fatalf("status: got %q, want error", status)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Error("job never reached a terminal status")
}
