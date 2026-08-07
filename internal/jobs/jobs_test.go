package jobs

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// Dropping base64 traded 33% of the bandwidth for one hazard: byte offsets can
// land in the middle of a multi-byte character. If that ever reaches the JSON
// encoder it substitutes U+FFFD and the client's stream is silently corrupted —
// a corruption that only shows up on non-ASCII text, which is exactly the kind
// of bug that ships.
func TestTrimToRuneBoundary(t *testing.T) {
	// "héllo→" has 2-byte é and a 3-byte arrow.
	full := []byte("héllo→")

	for cut := 1; cut <= len(full); cut++ {
		got := trimToRuneBoundary(full[:cut])
		if !utf8.Valid(got) {
			t.Errorf("cut at %d produced invalid UTF-8: %q", cut, got)
		}
		// What survives must be a prefix of the original, never rewritten.
		if string(got) != string(full[:len(got)]) {
			t.Errorf("cut at %d altered the bytes: got %q", cut, got)
		}
		// Round-tripping through JSON must not introduce a replacement char.
		encoded, err := json.Marshal(string(got))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(encoded), `�`) {
			t.Errorf("cut at %d produced U+FFFD after JSON encoding", cut)
		}
	}

	if got := trimToRuneBoundary([]byte("plain ascii")); string(got) != "plain ascii" {
		t.Errorf("valid input was altered: %q", got)
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
	// multi-byte characters in the payload, so read() must extend forward to a
	// character boundary rather than stall or emit a partial sequence.
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
			// What the client receives is a JSON string; re-encoding it must
			// yield exactly the bytes the offset advanced by.
			if len([]byte(string(chunk))) != next-offset {
				t.Fatalf("window %d: chunk re-encodes to %d bytes but next advanced %d",
					window, len(string(chunk)), next-offset)
			}
			assembled = append(assembled, chunk...)
			offset = next
		}
		if string(assembled) != body {
			t.Errorf("window %d: reassembled stream differs:\n got %q\nwant %q", window, assembled, body)
		}
	}
}

// Every chunk handed to the client must survive a JSON round trip unchanged.
// This is the invariant base64 used to provide for free.
func TestPollChunksSurviveJSONRoundTrip(t *testing.T) {
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
			encoded, err := json.Marshal(string(chunk))
			if err != nil {
				t.Fatal(err)
			}
			var decoded string
			if err := json.Unmarshal(encoded, &decoded); err != nil {
				t.Fatal(err)
			}
			if decoded != string(chunk) {
				t.Fatalf("window %d: chunk changed across JSON: %q -> %q", window, chunk, decoded)
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

	// Poll exactly as chat.html does: feed `chunk`, advance to `next`, stop on
	// a terminal status once drained.
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
			Status string `json:"status"`
			Size   int    `json:"size"`
			Next   int    `json:"next"`
			Chunk  string `json:"chunk"`
			Error  string `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &poll); err != nil {
			t.Fatal(err)
		}
		if poll.Chunk != "" {
			// The byte length of what arrived must equal the offset advance.
			if len(poll.Chunk) != poll.Next-offset {
				t.Fatalf("chunk is %d bytes but next advanced by %d", len(poll.Chunk), poll.Next-offset)
			}
			assembled = append(assembled, poll.Chunk...)
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

func TestJobConcurrencyCap(t *testing.T) {
	// The handler must hold the request open to occupy a slot, but it also has
	// to be releasable on demand: a handler that only waits on the request
	// context never returns if it has written nothing, and httptest.Close then
	// blocks forever waiting for it.
	release := make(chan struct{})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer upstream.Close()
	defer close(release) // runs before upstream.Close()

	m := NewManager(upstream.URL, "", 2, 48)

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs", strings.NewReader(`{}`)))
		if rec.Code != http.StatusAccepted {
			t.Fatalf("job %d: got %d, want 202", i, rec.Code)
		}
	}
	// Give the workers a moment to be counted as running.
	time.Sleep(50 * time.Millisecond)

	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs", strings.NewReader(`{}`)))
	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("third job past a cap of 2: got %d, want 429", rec.Code)
	}

	m.Shutdown()
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
