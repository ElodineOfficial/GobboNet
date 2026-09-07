//go:build !windows

package supervisor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newTestSupervisor builds a Supervisor pointed at a script that always fails,
// with an LLMURL nothing listens on so waitHealthy cannot accidentally pass.
func newTestSupervisor(t *testing.T, script string) *Supervisor {
	t.Helper()

	dir := t.TempDir()
	exe := filepath.Join(dir, "fake-llama-server")
	if err := os.WriteFile(exe, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake server: %v", err)
	}
	// A .gguf has to exist for anything that scans the model dir.
	if err := os.WriteFile(filepath.Join(dir, "model.gguf"), []byte("x"), 0o644); err != nil {
		t.Fatalf("write model: %v", err)
	}

	sup, err := New(Options{
		ServerExe: exe,
		ModelDir:  dir,
		// Port 1 is privileged and unbound; /health can never answer here.
		LLMURL:  "http://127.0.0.1:1",
		LogFile: filepath.Join(dir, "llama-server.log"),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return sup
}

// A crash-restart loop that keeps failing must say so through Status().
//
// Regression test for issue #43: the loop used to log its failures and leave
// Status() reporting whatever it said before the crash. A client asking
// /swap-status "is the model up, and if not why" got a stale "ready" while
// nothing was listening, which is precisely the question the landing page now
// relies on to explain itself.
func TestRestartAfterCrashPublishesFailure(t *testing.T) {
	sup := newTestSupervisor(t, "#!/bin/sh\necho 'ggml_vulkan: ErrorOutOfDeviceMemory' >&2\nexit 1\n")

	// Pretend a previous boot succeeded, which is the state that used to persist
	// through an unlimited run of failed restarts.
	sup.setStatus(PhaseReady, "model.gguf", "model.gguf", "Ready", time.Now().Unix())
	if got := sup.Status().Phase; got != PhaseReady {
		t.Fatalf("precondition: phase = %q, want %q", got, PhaseReady)
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		sup.restartAfterCrash("model.gguf")
	}()

	// The first attempt sleeps 1s of backoff, then fails; give it room.
	deadline := time.Now().Add(20 * time.Second)
	var last Status
	for time.Now().Before(deadline) {
		last = sup.Status()
		if last.Phase == PhaseError {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	// Stop the loop: it retries forever by design.
	sup.mu.Lock()
	sup.stopping = true
	sup.mu.Unlock()

	if last.Phase != PhaseError {
		t.Fatalf("phase = %q after failed restarts, want %q (stale status is the bug)",
			last.Phase, PhaseError)
	}
	if strings.TrimSpace(last.Message) == "" {
		t.Error("error status carried no message; the UI has nothing to show")
	}

	select {
	case <-done:
	case <-time.After(3 * time.Minute):
		t.Log("restart loop still running at teardown; backoff is long by design")
	}
}
