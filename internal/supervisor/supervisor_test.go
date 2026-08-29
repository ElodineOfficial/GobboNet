package supervisor

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRingBufferWriteAndString(t *testing.T) {
	rb := newRingBuffer(16)

	// Partial write
	rb.Write([]byte("hello"))
	if got := rb.String(); got != "hello" {
		t.Fatalf("expected 'hello', got %q", got)
	}

	// Exact fill
	rb.Reset()
	rb.Write([]byte("0123456789abcdef"))
	if got := rb.String(); got != "0123456789abcdef" {
		t.Fatalf("expected full string, got %q", got)
	}

	// Overflow wrap-around
	rb.Reset()
	rb.Write([]byte("prefix_0123456789abcdef_tail"))
	got := rb.String()
	if len(got) != 16 {
		t.Fatalf("expected length 16, got %d (%q)", len(got), got)
	}
	if !strings.HasSuffix(got, "_tail") {
		t.Fatalf("expected suffix '_tail', got %q", got)
	}
}

func TestRingBufferLastErrorExtraction(t *testing.T) {
	rb := newRingBuffer(1024)

	// No error markers
	rb.Write([]byte("loading weights...\ninitializing KV cache...\nserver listening on 127.0.0.1:8080\n"))
	if err := rb.LastError(); err != "" {
		t.Fatalf("expected empty LastError, got %q", err)
	}

	// Contains fatal out of memory marker
	rb.Write([]byte("CUDA error: out of memory allocating 4096 MiB\n"))
	if err := rb.LastError(); !strings.Contains(err, "out of memory") {
		t.Fatalf("expected 'out of memory' in LastError, got %q", err)
	}

	// Multiple markers: returns the last one
	rb.Reset()
	rb.Write([]byte("warning: unable to pin memory\nerror: address already in use\n"))
	if err := rb.LastError(); !strings.Contains(err, "address already in use") {
		t.Fatalf("expected 'address already in use' as most recent error, got %q", err)
	}
}

func TestRingBufferTail(t *testing.T) {
	rb := newRingBuffer(1024)
	rb.Write([]byte("line 1\nline 2\nline 3\nline 4\nline 5\n"))

	tail2 := rb.Tail(2)
	lines := strings.Split(tail2, "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 lines in tail, got %d (%q)", len(lines), tail2)
	}
	if lines[0] != "line 4" || lines[1] != "line 5" {
		t.Fatalf("unexpected tail lines: %v", lines)
	}
}

func TestRemoteModeHTTPHandlers(t *testing.T) {
	h := Handlers{Sup: nil} // Remote mode has nil supervisor

	// GET /swap-status in remote mode returns phase: idle
	req := httptest.NewRequest(http.MethodGet, "/swap-status", nil)
	rec := httptest.NewRecorder()
	h.HandleSwapStatus(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 OK, got %d", rec.Code)
	}
	var status struct {
		Phase string `json:"phase"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&status); err != nil {
		t.Fatalf("decode failed: %v", err)
	}
	if status.Phase != PhaseIdle {
		t.Fatalf("expected phase 'idle', got %q", status.Phase)
	}

	// POST /swap-model in remote mode returns 503 Service Unavailable
	body := strings.NewReader(`{"file":"test.gguf"}`)
	req = httptest.NewRequest(http.MethodPost, "/swap-model", body)
	rec = httptest.NewRecorder()
	h.HandleSwapModel(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 Service Unavailable, got %d", rec.Code)
	}
}
