//go:build !windows

package supervisor

import (
	"bytes"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Crash recovery retries until it succeeds, as it did in 1.7.5. The memory-QOL
// change capped it at three attempts (about seven seconds), after which a model
// that could have come back -- a GPU driver reset, a card briefly held by
// another program -- stayed down until someone selected a model by hand.

// The engine: this test binary, failing fast while a budget file holds a
// positive count and serving /health once it is spent.
func TestRecoveryEngineHelper(t *testing.T) {
	if os.Getenv("GOBBONET_RECOVERY_HELPER") != "1" {
		return
	}
	if path := os.Getenv("GOBBONET_RECOVERY_FAILS"); path != "" {
		if b, err := os.ReadFile(path); err == nil {
			if n, _ := strconv.Atoi(strings.TrimSpace(string(b))); n > 0 {
				os.WriteFile(path, []byte(strconv.Itoa(n-1)), 0600)
				os.Exit(3)
			}
		}
	}
	port := ""
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port = os.Args[i+1]
		}
	}
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("ok")) })
	if err := http.ListenAndServe("127.0.0.1:"+port, nil); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

type logCapture struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (c *logCapture) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.Write(p)
}

func (c *logCapture) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.buf.String()
}

func captureLog(t *testing.T) *logCapture {
	t.Helper()
	c := &logCapture{}
	prev := log.Writer()
	log.SetOutput(c)
	t.Cleanup(func() { log.SetOutput(prev) })
	return c
}

func recoverySupervisor(t *testing.T) (*Supervisor, string) {
	t.Helper()
	t.Setenv("GOBBONET_RECOVERY_HELPER", "1")
	dir := t.TempDir()
	budget := filepath.Join(dir, "fails")
	t.Setenv("GOBBONET_RECOVERY_FAILS", budget)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "engine")
	if err = os.WriteFile(script, []byte(fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestRecoveryEngineHelper$ -- \"$@\"\n", exe)), 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(dir, "model.gguf"), []byte("test"), 0600); err != nil {
		t.Fatal(err)
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	s, err := New(Options{
		ServerExe: script, ModelDir: dir, LLMURL: "http://127.0.0.1:" + strconv.Itoa(port),
		LogFile: filepath.Join(dir, "engine.log"), LoadTimeout: 3 * time.Second,
		RecoveryBackoff: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)
	return s, budget
}

// crash ends the running engine the way a real crash does: no stop(), so the
// reaper sees an unexpected exit and starts recovery.
func crash(t *testing.T, s *Supervisor) {
	t.Helper()
	s.mu.Lock()
	cmd := s.cmd
	s.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		t.Fatal("no engine to crash")
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
}

func waitForLog(t *testing.T, c *logCapture, want string, count int, within time.Duration) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if strings.Count(c.String(), want) >= count {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("waited %s for %d x %q; log:\n%s", within, count, want, c.String())
}

func TestCrashRecoveryOutlastsMoreThanThreeFailures(t *testing.T) {
	logs := captureLog(t)
	s, budget := recoverySupervisor(t)
	if err := s.Boot("model.gguf"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(budget, []byte("5"), 0600); err != nil {
		t.Fatal(err)
	}
	crash(t, s)
	waitForLog(t, logs, "[swap] llama-server recovered", 1, 30*time.Second)

	out := logs.String()
	if n := strings.Count(out, "[swap] restart failed:"); n != 5 {
		t.Errorf("want each of the 5 failed restarts reported with its reason, got %d:\n%s", n, out)
	}
	if !strings.Contains(out, "[swap] restart attempt 6 for model.gguf") {
		t.Errorf("recovery did not reach a sixth attempt:\n%s", out)
	}
	if strings.Contains(out, "recovery stopped") {
		t.Errorf("recovery gave up:\n%s", out)
	}
	if st := s.Status(); st.Phase != PhaseReady {
		t.Fatalf("after recovery: %+v", st)
	}
	s.mu.Lock()
	host, port := s.host, s.port
	s.mu.Unlock()
	resp, err := http.Get("http://" + net.JoinHostPort(host, port) + "/health")
	if err != nil {
		t.Fatalf("recovered engine is not serving: %v", err)
	}
	resp.Body.Close()
}

func TestShutdownEndsAnUnboundedRecovery(t *testing.T) {
	logs := captureLog(t)
	s, budget := recoverySupervisor(t)
	if err := s.Boot("model.gguf"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(budget, []byte("100000"), 0600); err != nil {
		t.Fatal(err)
	}
	crash(t, s)
	waitForLog(t, logs, "[swap] restart failed:", 3, 30*time.Second)

	s.Shutdown()
	settled := strings.Count(logs.String(), "[swap] restart attempt")
	// Longer than the backoff has reached by now, so a surviving loop would
	// have logged another attempt.
	time.Sleep(600 * time.Millisecond)
	if after := strings.Count(logs.String(), "[swap] restart attempt"); after != settled {
		t.Fatalf("recovery kept running after shutdown (%d -> %d attempts)", settled, after)
	}
	assertReleased(t, s)
}
