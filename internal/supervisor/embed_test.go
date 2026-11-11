//go:build !windows

package supervisor

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// 1.8.0 (#15): GobboNet supervises the embedding server. The engine here is
// this test binary: it records its arguments, fails fast while a budget file
// holds a positive count, and otherwise serves /health on --port.
func TestEmbedEngineHelper(t *testing.T) {
	if os.Getenv("GOBBONET_EMBED_HELPER") != "1" {
		return
	}
	if path := os.Getenv("GOBBONET_EMBED_ARGS"); path != "" {
		f, _ := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		args := os.Args[1:]
		for i, a := range args {
			if a == "--" {
				args = args[i+1:]
				break
			}
		}
		fmt.Fprintln(f, strings.Join(args, " "))
		f.Close()
	}
	if path := os.Getenv("GOBBONET_EMBED_FAILS"); path != "" {
		if b, err := os.ReadFile(path); err == nil {
			if n, _ := strconv.Atoi(strings.TrimSpace(string(b))); n > 0 {
				os.WriteFile(path, []byte(strconv.Itoa(n-1)), 0o600)
				fmt.Fprintln(os.Stderr, "error: failed to load model 'x.gguf'")
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
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{"status":"ok"}`)) })
	if err := http.ListenAndServe("127.0.0.1:"+port, nil); err != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

type embedRig struct {
	e      *Embedder
	dir    string
	args   string
	budget string
	model  string
	port   int
}

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func newEmbedRig(t *testing.T, pinOverride string) *embedRig {
	t.Helper()
	t.Setenv("GOBBONET_EMBED_HELPER", "1")
	dir := t.TempDir()
	r := &embedRig{dir: dir, args: filepath.Join(dir, "args"), budget: filepath.Join(dir, "fails"), model: filepath.Join(dir, "nomic.gguf"), port: freePort(t)}
	t.Setenv("GOBBONET_EMBED_ARGS", r.args)
	t.Setenv("GOBBONET_EMBED_FAILS", r.budget)
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(dir, "engine")
	if err := os.WriteFile(script, []byte(fmt.Sprintf("#!/bin/sh\nexec %q -test.run=^TestEmbedEngineHelper$ -- \"$@\"\n", exe)), 0o700); err != nil {
		t.Fatal(err)
	}
	body := []byte("an embedding model")
	if err := os.WriteFile(r.model, body, 0o600); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(body)
	pin := hex.EncodeToString(sum[:])
	if pinOverride != "" {
		pin = pinOverride
	}
	r.e, err = NewEmbedder(EmbedOptions{
		ServerExe: script, Model: r.model, Pin: pin,
		URL: "http://127.0.0.1:" + strconv.Itoa(r.port), Ctx: 2048,
		LogFile:         filepath.Join(dir, "embed-server.log"),
		RecoveryBackoff: 20 * time.Millisecond, LoadTimeout: 5 * time.Second, AdoptPoll: 50 * time.Millisecond,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(r.e.Shutdown)
	return r
}

func (r *embedRig) waitState(t *testing.T, want string, within time.Duration) EmbedStatus {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if st := r.e.Status(); st.State == want {
			return st
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("waited %s for %q; status %+v", within, want, r.e.Status())
	return EmbedStatus{}
}

func (r *embedRig) answers() bool {
	resp, err := http.Get("http://127.0.0.1:" + strconv.Itoa(r.port) + "/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

func (r *embedRig) starts() int {
	b, _ := os.ReadFile(r.args)
	return strings.Count(string(b), "\n")
}

func TestEmbedderStartsWithTheFullFlagSet(t *testing.T) {
	r := newEmbedRig(t, "")
	r.e.Start()
	r.waitState(t, EmbedRunning, 10*time.Second)
	if !r.answers() {
		t.Fatal("running, but nothing answers on the port")
	}
	b, _ := os.ReadFile(r.args)
	want := fmt.Sprintf("--model %s --host 127.0.0.1 --port %d --embeddings --pooling mean --ctx-size 2048 --batch-size 2048 --ubatch-size 2048 --n-gpu-layers 0", r.model, r.port)
	if strings.TrimSpace(string(b)) != want {
		t.Errorf("command line:\n got %s\nwant %s", strings.TrimSpace(string(b)), want)
	}
	if log, _ := os.ReadFile(filepath.Join(r.dir, "embed-server.log")); !strings.Contains(string(log), "starting the embedding server for nomic.gguf") {
		t.Errorf("the log does not mark the run: %q", log)
	}
}

func TestEmbedderComesBackAfterACrash(t *testing.T) {
	logs := captureLog(t)
	r := newEmbedRig(t, "")
	r.e.Start()
	r.waitState(t, EmbedRunning, 10*time.Second)
	os.WriteFile(r.budget, []byte("2"), 0o600) // the next two starts fail
	r.e.mu.Lock()
	cmd := r.e.cmd
	r.e.mu.Unlock()
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	r.waitState(t, EmbedRestarting, 5*time.Second)
	r.waitState(t, EmbedRunning, 20*time.Second)
	out := logs.String()
	for _, want := range []string{"[embed] restart attempt 1", "[embed] restart attempt 3", "[embed] embedding server recovered", "failed to load model"} {
		if !strings.Contains(out, want) {
			t.Errorf("log lacks %q:\n%s", want, out)
		}
	}
	if !r.answers() {
		t.Error("recovered, but nothing answers")
	}
}

func TestEmbedderRefusesAModelThatDoesNotMatchItsPin(t *testing.T) {
	logs := captureLog(t)
	r := newEmbedRig(t, strings.Repeat("0", 64))
	r.e.Start()
	st := r.waitState(t, EmbedFailed, 10*time.Second)
	if !strings.Contains(st.Detail, "does not match its pinned SHA-256") || !strings.Contains(st.Detail, "run setup again") {
		t.Errorf("detail: %q", st.Detail)
	}
	time.Sleep(300 * time.Millisecond) // many backoffs' worth
	if n := r.starts(); n != 0 {
		t.Errorf("a mismatched model was started %d time(s)", n)
	}
	if strings.Contains(logs.String(), "restart attempt") {
		t.Errorf("a mismatch that cannot clear was retried:\n%s", logs.String())
	}
}

func TestEmbedderWithNoModelSaysWhere(t *testing.T) {
	r := newEmbedRig(t, "")
	os.Remove(r.model)
	r.e.Start()
	st := r.waitState(t, EmbedFailed, 5*time.Second)
	if !strings.Contains(st.Detail, "no embedding model at "+r.model) || !strings.Contains(st.Detail, "setup wizard download it") {
		t.Errorf("detail: %q", st.Detail)
	}
}

func TestEmbedderUsesAServerItDidNotStartUntilItGoes(t *testing.T) {
	r := newEmbedRig(t, "")
	theirs := &http.Server{Addr: "127.0.0.1:" + strconv.Itoa(r.port), Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(`{"status":"ok"}`)) })}
	ln, err := net.Listen("tcp", theirs.Addr)
	if err != nil {
		t.Fatal(err)
	}
	go theirs.Serve(ln)
	r.e.Start()
	st := r.waitState(t, EmbedExternal, 5*time.Second)
	if !strings.Contains(st.Detail, "did not start") {
		t.Errorf("detail: %q", st.Detail)
	}
	if r.starts() != 0 {
		t.Error("it started a second server on a taken port")
	}
	theirs.Close()
	r.waitState(t, EmbedRunning, 10*time.Second)
	if r.starts() != 1 {
		t.Errorf("starts after theirs went: %d", r.starts())
	}
}

func TestEmbedderStandsDownAndWakesWithTheChatModel(t *testing.T) {
	r := newEmbedRig(t, "")
	r.e.Start()
	r.waitState(t, EmbedRunning, 10*time.Second)
	r.e.StandDown()
	if st := r.e.Status(); st.State != EmbedStandby {
		t.Fatalf("after stand-down: %+v", st)
	}
	if r.answers() {
		t.Error("stood down, but still answering")
	}
	r.e.WakeAndWait(10 * time.Second)
	if st := r.e.Status(); st.State != EmbedRunning || !r.answers() {
		t.Fatalf("after wake: %+v", st)
	}
	r.e.WakeAndWait(time.Second) // not stood down: returns at once, changes nothing
	if r.starts() != 2 {
		t.Errorf("starts: %d, want 2", r.starts())
	}
}

func TestEmbedderShutdownEndsRecovery(t *testing.T) {
	logs := captureLog(t)
	r := newEmbedRig(t, "")
	r.e.Start()
	r.waitState(t, EmbedRunning, 10*time.Second)
	os.WriteFile(r.budget, []byte("100000"), 0o600)
	r.e.mu.Lock()
	cmd := r.e.cmd
	r.e.mu.Unlock()
	cmd.Process.Kill()
	waitForLog(t, logs, "[embed] restart attempt", 3, 20*time.Second)
	r.e.Shutdown()
	settled := strings.Count(logs.String(), "[embed] restart attempt")
	time.Sleep(500 * time.Millisecond)
	if after := strings.Count(logs.String(), "[embed] restart attempt"); after != settled {
		t.Fatalf("recovery kept going after shutdown (%d -> %d)", settled, after)
	}
	if r.answers() {
		t.Error("still answering after shutdown")
	}
}

func TestEmbedderNeedsAHostAndPort(t *testing.T) {
	if _, err := NewEmbedder(EmbedOptions{URL: "http://127.0.0.1"}); err == nil {
		t.Error("an embed_url with no port was accepted")
	}
}

// The chat model's stand-down takes the embedding server with it, and its
// wake brings it back -- after the chat model has loaded.
func TestChatStandDownCarriesItsCompanion(t *testing.T) {
	s, _ := recoverySupervisor(t)
	if err := s.Boot("model.gguf"); err != nil {
		t.Fatal(err)
	}
	var order []string
	s.OnStandDown = func() { order = append(order, "down") }
	s.OnWake = func() { order = append(order, "wake:"+s.Status().Phase) }
	if err := s.StandDown(); err != nil {
		t.Fatal(err)
	}
	if err := s.EnsureAwake(); err != nil {
		t.Fatal(err)
	}
	if strings.Join(order, ",") != "down,wake:"+PhaseReady {
		t.Errorf("order: %v", order)
	}
}
