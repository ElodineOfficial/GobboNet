package jobs

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// A job must always reach a terminal status. The frontend polls until it does;
// anything that leaves a job at "running" is a spinner that never stops, with
// nothing logged anywhere to explain it.
//
// The three ways an upstream can fail to finish are covered here: it refuses
// the connection, it accepts and never answers, or it answers and then goes
// silent mid-stream. Only the first of these was bounded before.

// startJob posts a generation and returns its id.
func startJob(t *testing.T, m *Manager) string {
	t.Helper()
	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs?thread=t1",
		strings.NewReader(`{"messages":[]}`)))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("create job: got %d, want 202 (body %s)", rec.Code, rec.Body)
	}
	var created struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &created); err != nil {
		t.Fatalf("decode create response: %v", err)
	}
	if created.ID == "" {
		t.Fatal("create response carried no id")
	}
	return created.ID
}

// awaitTerminal waits for the job to leave "running" and returns its status and
// error message.
func awaitTerminal(t *testing.T, m *Manager, id string, within time.Duration) (status, errMsg string) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		status, errMsg, _, _, _ = mustGet(t, m, id).snapshot()
		if status != StatusRunning {
			return status, errMsg
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("job %s still %q after %s -- this is the hang", id, StatusRunning, within)
	return "", ""
}

// silentListener accepts connections and never writes a byte, which is what a
// deadlocked llama.cpp, a GPU hang, or a firewall that DROPs rather than
// REJECTs looks like from here.
func silentListener(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		var held []net.Conn
		defer func() {
			for _, c := range held {
				c.Close()
			}
		}()
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			// Hold the connection open and say nothing.
			held = append(held, c)
		}
	}()
	return "http://" + ln.Addr().String()
}

// TestDeadUpstreamReachesError covers the refused-connection case: llama.cpp is
// not running at all. This one always worked; it is pinned so the staged
// timeouts added for the other two cannot regress it.
func TestDeadUpstreamReachesError(t *testing.T) {
	m := NewManager("http://127.0.0.1:1", "", 4, 24)
	id := startJob(t, m)

	status, errMsg := awaitTerminal(t, m, id, 5*time.Second)
	if status != StatusError {
		t.Errorf("status = %q, want %q", status, StatusError)
	}
	if errMsg == "" {
		t.Error("a failed job carries no error message")
	}
}

// TestWedgedUpstreamReachesError is the hang this change exists for.
//
// The socket is accepted and then nothing arrives. Before the first-byte bound,
// the read blocked until the 30-minute cap: half an hour of spinner with no
// error recorded anywhere. An http.Client.Timeout cannot express this, because
// that clock covers the streaming body too and any value large enough for a
// real generation is too large to catch a wedge.
func TestWedgedUpstreamReachesError(t *testing.T) {
	m := NewManager(silentListener(t), "", 4, 24)
	m.client = newJobClient(200*time.Millisecond, 400*time.Millisecond)

	id := startJob(t, m)
	status, errMsg := awaitTerminal(t, m, id, 5*time.Second)

	if status != StatusError {
		t.Fatalf("status = %q, want %q (a silent upstream must not read as cancelled)", status, StatusError)
	}
	if errMsg == "" {
		t.Error("a wedged upstream produced no error message")
	}
}

// TestStalledStreamReachesError covers the harder case: headers arrive, some
// tokens arrive, and then the upstream goes silent without closing. There is no
// EOF to end the read loop and the response-header bound is already spent, so
// only the between-chunks watchdog can end it.
func TestStalledStreamReachesError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n"))
		w.(http.Flusher).Flush()
		// Then stall, holding the response open without closing it. Bounded so
		// a regression in the watchdog fails this test rather than wedging the
		// whole suite on httptest's Close, which waits for handlers.
		select {
		case <-r.Context().Done():
		case <-time.After(20 * time.Second):
		}
	}))
	t.Cleanup(upstream.Close)

	m := NewManager(upstream.URL, "", 4, 24)
	m.idle = 300 * time.Millisecond

	id := startJob(t, m)
	status, errMsg := awaitTerminal(t, m, id, 10*time.Second)

	if status != StatusError {
		t.Fatalf("status = %q, want %q (a stalled stream must not read as cancelled)", status, StatusError)
	}
	if !strings.Contains(errMsg, "stopped sending") {
		t.Errorf("error message %q does not explain the stall", errMsg)
	}

	// The bytes that did arrive are still readable: a stall must not discard
	// the partial reply the user can already see on screen.
	chunk, size, _ := mustGet(t, m, id).read(0, 4096)
	if size == 0 || !strings.Contains(string(chunk), "hi") {
		t.Errorf("partial output lost on stall: size=%d chunk=%q", size, chunk)
	}
}

// TestHealthyStreamIsNotKilledByTheWatchdog is the guard on the other side. A
// generation that keeps producing must never be cut off, however long it runs —
// the watchdog bounds the GAP between chunks, not the total duration.
//
// Without this, a slow model on a big context would look exactly like a wedge.
func TestHealthyStreamIsNotKilledByTheWatchdog(t *testing.T) {
	const chunks = 12
	const gap = 60 * time.Millisecond

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		for i := 0; i < chunks; i++ {
			w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"))
			w.(http.Flusher).Flush()
			time.Sleep(gap)
		}
	}))
	t.Cleanup(upstream.Close)

	m := NewManager(upstream.URL, "", 4, 24)
	// Comfortably longer than one gap, far shorter than the whole stream. A
	// total-duration timeout would fire here; a between-chunks one must not.
	m.idle = 4 * gap

	id := startJob(t, m)
	status, errMsg := awaitTerminal(t, m, id, 15*time.Second)

	if status != StatusDone {
		t.Fatalf("status = %q (err %q), want %q -- the watchdog cut a healthy stream",
			status, errMsg, StatusDone)
	}
}

// TestCancelStillReadsAsCancelled keeps the new causes from swallowing the
// user's own action. Cancel and watchdog trip arrive as the same cancellation
// at the socket; only the cause separates them, and reporting a stop button as
// an upstream error would be as wrong as the reverse.
func TestCancelStillReadsAsCancelled(t *testing.T) {
	m := NewManager(silentListener(t), "", 4, 24)
	id := startJob(t, m)

	rec := httptest.NewRecorder()
	m.Handle(rec, httptest.NewRequest(http.MethodPost, "/llm/jobs/"+id+"/cancel", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("cancel: got %d, want 200 (body %s)", rec.Code, rec.Body)
	}

	status, _ := awaitTerminal(t, m, id, 5*time.Second)
	if status != StatusCancelled {
		t.Errorf("status = %q, want %q", status, StatusCancelled)
	}
}

// TestExpiredJobReportsAnError pins the outermost cap. Running past it is a
// failure the user needs told about; it previously shared a code path with
// cancellation and would have reported a generation that died on its own as
// something they stopped themselves.
func TestExpiredJobReportsAnError(t *testing.T) {
	m := NewManager(silentListener(t), "", 4, 24)
	// Shorter than the idle watchdog, so the cap is what fires.
	m.maxRuntime = 300 * time.Millisecond
	m.idle = 30 * time.Second

	id := startJob(t, m)
	status, errMsg := awaitTerminal(t, m, id, 5*time.Second)

	if status != StatusError {
		t.Fatalf("status = %q, want %q", status, StatusError)
	}
	if !strings.Contains(errMsg, "limit") {
		t.Errorf("error message %q does not explain the runtime cap", errMsg)
	}
}
