//go:build !windows

package supervisor

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// A real child process and HTTP listener, without a model, GPU or downloads.
func TestLifecycleEngineHelper(t *testing.T) {
	if os.Getenv("GOBBONET_LIFECYCLE_HELPER") != "1" {
		return
	}
	port := ""
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port = os.Args[i+1]
		}
	}
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if os.Getenv("GOBBONET_LIFECYCLE_STALL") == "1" {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte("ok"))
	})
	if err := http.ListenAndServe("127.0.0.1:"+port, nil); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func lifecycleSupervisor(t *testing.T) *Supervisor {
	t.Helper()
	t.Setenv("GOBBONET_LIFECYCLE_HELPER", "1")
	dir := t.TempDir()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "engine")
	if err = os.WriteFile(script, []byte(fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestLifecycleEngineHelper$ -- \"$@\"\n", exe)), 0700); err != nil {
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
	s, err := New(Options{ServerExe: script, ModelDir: dir, LLMURL: "http://127.0.0.1:" + strconv.Itoa(port), LogFile: filepath.Join(dir, "engine.log"), LoadTimeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Shutdown)
	return s
}

func assertReleased(t *testing.T, s *Supervisor) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil || s.pgid != 0 {
		t.Fatalf("engine ownership remains: cmd=%v pgid=%d", s.cmd, s.pgid)
	}
}

func TestTimedOutBootReleasesEngine(t *testing.T) {
	s := lifecycleSupervisor(t)
	s.opts.LoadTimeout = 100 * time.Millisecond
	t.Setenv("GOBBONET_LIFECYCLE_STALL", "1")
	if err := s.Boot("model.gguf"); err == nil {
		t.Fatal("expected startup timeout")
	}
	assertReleased(t, s)
	if s.Status().Phase != PhaseError {
		t.Fatal(s.Status())
	}
}

func TestIdleCannotUnloadActiveRequestAndWakeIsSingle(t *testing.T) {
	s := lifecycleSupervisor(t)
	if err := s.Boot("model.gguf"); err != nil {
		t.Fatal(err)
	}
	release, err := s.AcquireRequest()
	if err != nil {
		t.Fatal(err)
	}
	if err = s.StandDown(); err == nil {
		t.Fatal("unloaded with a request in flight")
	}
	if ok, _ := s.standDownDecision(time.Now().Add(time.Hour), time.Minute); ok {
		t.Fatal("idle decision ignored active generation")
	}
	release()
	if err = s.StandDown(); err != nil {
		t.Fatal(err)
	}
	assertReleased(t, s)
	s.mu.Lock()
	generation := s.generation
	s.mu.Unlock()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			done, e := s.AcquireRequest()
			if e != nil {
				t.Error(e)
				return
			}
			done()
		}()
	}
	wg.Wait()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.generation != generation+1 || s.inFlight != 0 {
		t.Fatalf("loads=%d requests=%d", s.generation-generation, s.inFlight)
	}
}

func TestFailedWakeCleansUpBeforeRetry(t *testing.T) {
	s := lifecycleSupervisor(t)
	if err := s.Boot("model.gguf"); err != nil {
		t.Fatal(err)
	}
	if err := s.StandDown(); err != nil {
		t.Fatal(err)
	}
	s.opts.LoadTimeout = 100 * time.Millisecond
	t.Setenv("GOBBONET_LIFECYCLE_STALL", "1")
	for i := 0; i < 2; i++ {
		if err := s.EnsureAwake(); err == nil {
			t.Fatal("expected failed wake")
		}
		assertReleased(t, s)
	}
}

func TestShutdownDuringBootCannotRestart(t *testing.T) {
	s := lifecycleSupervisor(t)
	t.Setenv("GOBBONET_LIFECYCLE_STALL", "1")
	done := make(chan error, 1)
	go func() { done <- s.Boot("model.gguf") }()
	deadline := time.Now().Add(time.Second)
	for {
		s.mu.Lock()
		started := s.cmd != nil
		s.mu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child never started")
		}
		time.Sleep(time.Millisecond)
	}
	s.Shutdown()
	if err := <-done; err == nil {
		t.Fatal("boot succeeded during shutdown")
	}
	assertReleased(t, s)
	if err := s.Boot("model.gguf"); err == nil {
		t.Fatal("boot resurrected after shutdown")
	}
	if _, err := s.AcquireRequest(); err == nil {
		t.Fatal("accepted work after shutdown")
	}
}

func TestOccupiedEnginePortDoesNotLaunchOrKill(t *testing.T) {
	s := lifecycleSupervisor(t)
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("foreign")) }))
	defer up.Close()
	_, port, _ := net.SplitHostPort(strings.TrimPrefix(up.URL, "http://"))
	s.port = port
	if err := s.Boot("model.gguf"); err == nil || !strings.Contains(err.Error(), "occupied") {
		t.Fatalf("got %v", err)
	}
	assertReleased(t, s)
	// Restore the unbound address so cleanup does not wait on a foreign server.
	s.port = "1"
}

func TestAutomaticMemoryChecksEngineWithoutLoadingWeights(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "engine")
	count := filepath.Join(dir, "calls")
	body := fmt.Sprintf("#!/bin/sh\necho called >> %q\nif [ \"$1\" != --help ]; then exit 1; fi\necho '--fit on --fit-target N --fit-ctx N'\n", count)
	if err := os.WriteFile(exe, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	s, _ := New(Options{ServerExe: exe, LLMURL: "http://127.0.0.1:1", GPUReserveMiB: 1024})
	for i := 0; i < 2; i++ {
		if err := s.checkMemoryArgs([]string{"--n-gpu-layers", "auto"}); err != nil {
			t.Fatal(err)
		}
	}
	data, _ := os.ReadFile(count)
	if strings.Count(string(data), "called") != 1 {
		t.Fatal("help probe was not cached")
	}
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho 'older engine without fitting options'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := s.checkMemoryArgs([]string{"--n-gpu-layers", "auto"}); err == nil {
		t.Fatal("unsupported auto flags accepted")
	}
	if err := s.checkMemoryArgs([]string{"--n-gpu-layers", "20"}); err != nil {
		t.Fatal("explicit layer count unnecessarily requires fitting")
	}
}
