package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/mcp/mcptest"
)

type harness struct {
	t      *testing.T
	m      *Manager
	dir    string
	record string
}

func newHarness(t *testing.T, opts Options) *harness {
	t.Helper()
	dir := t.TempDir()
	if opts.LogDir == "" {
		opts.LogDir = dir
	}
	if opts.Environ == nil {
		opts.Environ = os.Environ
	}
	m := NewManager(opts)
	t.Cleanup(m.Shutdown)
	return &harness{t: t, m: m, dir: dir, record: filepath.Join(dir, "record.txt")}
}

func (h *harness) server(name, mode string, enabled bool) config.MCPServer {
	return mcptest.Server(h.t, name, mode, h.record, enabled)
}

func (h *harness) status(name string) Status {
	for _, s := range h.m.Status() {
		if s.Name == name {
			return s
		}
	}
	h.t.Fatalf("no server %q", name)
	return Status{}
}

func (h *harness) tools(name string) Status {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, s := range h.m.Tools(ctx, false) {
		if s.Name == name {
			return s
		}
	}
	h.t.Fatalf("no server %q", name)
	return Status{}
}

func (h *harness) call(name, tool, args string, maxChars int) (*Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return h.m.Call(ctx, name, tool, json.RawMessage(args), maxChars)
}

func (h *harness) pids() []int {
	var out []int
	for _, l := range recorded(h.t, h.record) {
		if p, ok := strings.CutPrefix(l, "pid "); ok {
			n, _ := strconv.Atoi(p)
			out = append(out, n)
		}
	}
	return out
}

func waitUntil(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func kindOf(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Kind
	}
	return ""
}

// The whole path: a server is started on first use, answers the client's
// ping on the way, has its paged tool list read, and runs a tool.
func TestListAndCall(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "normal", true)}, 5*time.Second)

	if st := h.status("fake"); st.State != StateIdle {
		t.Fatalf("an enabled server must not start until it is needed; state %q", st.State)
	}
	if len(h.pids()) != 0 {
		t.Fatal("Update started a program")
	}

	st := h.tools("fake")
	if st.State != StateReady {
		t.Fatalf("state %q (%s), want ready", st.State, st.Detail)
	}
	var names []string
	for _, tl := range st.Tools {
		names = append(names, tl.Name)
	}
	// Both pages, and the tool with a newline in its name left out.
	if got := strings.Join(names, ","); got != "echo,slow,crash,big,mixed,fails,addtool" {
		t.Fatalf("tools: %s", got)
	}
	if !st.Tools[0].ReadOnly || st.Tools[2].ReadOnly {
		t.Error("read_only must follow readOnlyHint, and only it")
	}
	if st.Server == nil || st.Server.Name != "fake-mcp" {
		t.Errorf("serverInfo: %+v", st.Server)
	}
	rec := strings.Join(recorded(t, h.record), "\n")
	if !strings.Contains(rec, "pong {}") {
		t.Errorf("the client did not answer the server's ping with {}:\n%s", rec)
	}
	if !strings.Contains(rec, "method notifications/initialized") {
		t.Error("notifications/initialized was not sent")
	}

	res, err := h.call("fake", "echo", `{"text":"hello"}`, 0)
	if err != nil {
		t.Fatal(err)
	}
	if res.Text != `echo: {"text":"hello"}` || res.IsError || res.Truncated {
		t.Errorf("result: %+v", res)
	}
	// One process for all of it.
	if n := len(h.pids()); n != 1 {
		t.Errorf("%d processes started, want 1", n)
	}

	// The log has the program's own lines and GobboNet's, never the call's
	// arguments or result.
	raw, _ := os.ReadFile(filepath.Join(h.dir, "mcp-fake.log"))
	log := string(raw)
	if !strings.Contains(log, "ready: fake-mcp") || !strings.Contains(log, "call echo: ok") {
		t.Errorf("log:\n%s", log)
	}
	if strings.Contains(log, "hello") {
		t.Error("the log holds a tool's arguments or result")
	}
}

// A call that runs past mcp_call_timeout_seconds is given up on, the server
// is told it was cancelled, and the server goes on working.
func TestCallTimeout(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "normal", true)}, time.Second)

	began := time.Now()
	_, err := h.call("fake", "slow", `{}`, 0)
	if kindOf(err) != KindTimeout {
		t.Fatalf("got %v, want a timeout", err)
	}
	if !strings.Contains(err.Error(), "mcp_call_timeout_seconds") {
		t.Errorf("the message should name the setting: %v", err)
	}
	if d := time.Since(began); d > 15*time.Second {
		t.Errorf("took %s", d)
	}
	waitUntil(t, "the cancellation", 5*time.Second, func() bool {
		return strings.Contains(strings.Join(recorded(t, h.record), "\n"), "cancelled ")
	})
	if _, err := h.call("fake", "echo", `{}`, 0); err != nil {
		t.Errorf("the server should still work after a timeout: %v", err)
	}
}

// A server that exits during a call fails the call with its last words, and
// is started again on the next use once the backoff has passed.
func TestCrashThenRestart(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "normal", true)}, 10*time.Second)

	_, err := h.call("fake", "crash", `{}`, 0)
	if kindOf(err) != KindUnavailable {
		t.Fatalf("got %v, want unavailable", err)
	}
	waitUntil(t, "the failure to be recorded", 10*time.Second, func() bool { return h.status("fake").State == StateFailed })
	st := h.status("fake")
	if !strings.Contains(st.Detail, "boom: the tool fell over") || !strings.Contains(st.Detail, "exit status 3") {
		t.Errorf("detail: %q", st.Detail)
	}
	first := h.pids()[0]
	waitUntil(t, "the crashed process to be gone", 10*time.Second, func() bool { return !alive(first) })

	// Within the backoff a call fails at once rather than starting it again.
	if _, err := h.call("fake", "echo", `{}`, 0); err == nil || !strings.Contains(err.Error(), "tried again in") {
		t.Errorf("a call inside the backoff: %v", err)
	}
	time.Sleep(1200 * time.Millisecond)
	res, err := h.call("fake", "echo", `{"n":1}`, 0)
	if err != nil {
		t.Fatalf("not restarted: %v", err)
	}
	if res.Text != `echo: {"n":1}` {
		t.Errorf("result %q", res.Text)
	}
	if n := len(h.pids()); n != 2 {
		t.Errorf("%d processes, want 2", n)
	}
}

func TestStartFailureSaysWhy(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "exit", true)}, 0)
	st := h.tools("fake")
	if st.State != StateFailed {
		t.Fatalf("state %q", st.State)
	}
	if !strings.Contains(st.Detail, "fatal: config missing") || !strings.Contains(st.Detail, "exit status 2") {
		t.Errorf("detail: %q", st.Detail)
	}
	if st.RetryIn < 1 {
		t.Errorf("retry_in_seconds %d", st.RetryIn)
	}
}

func TestStartTimeout(t *testing.T) {
	h := newHarness(t, Options{StartTimeout: time.Second})
	h.m.Update([]config.MCPServer{h.server("fake", "silent", true)}, 0)
	st := h.tools("fake")
	if st.State != StateFailed || !strings.Contains(st.Detail, "no answer within 1s") {
		t.Fatalf("state %q, detail %q", st.State, st.Detail)
	}
	pid := h.pids()[0]
	waitUntil(t, "the silent server to be stopped", 10*time.Second, func() bool { return !alive(pid) })
}

func TestUnsupportedVersionRefused(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "oldversion", true)}, 0)
	st := h.tools("fake")
	if st.State != StateFailed || !strings.Contains(st.Detail, "1999-01-01") {
		t.Fatalf("state %q, detail %q", st.State, st.Detail)
	}
}

func TestServerWithNoTools(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "notools", true)}, 0)
	st := h.tools("fake")
	if st.State != StateReady || len(st.Tools) != 0 || !strings.Contains(st.Detail, "no tools") {
		t.Fatalf("%+v", st)
	}
}

// The program gets PATH and its like, and its own env table -- never
// GobboNet's secrets or anything else from the environment.
func TestServerEnvironmentIsFiltered(t *testing.T) {
	h := newHarness(t, Options{Environ: func() []string {
		return []string{
			"PATH=" + os.Getenv("PATH"), "HOME=/home/someone",
			"GOBBONET_ACCESS_SECRET=pbkdf2$secret", "GOBBONET_LLM_API_KEY=sk-live",
			"AWS_SECRET_ACCESS_KEY=abc", "BASH_FUNC_x%%=() { :; }",
			// How this machine reaches the internet, which npx -y needs.
			"HTTPS_PROXY=http://proxy.corp:8080", "https_proxy=http://proxy.corp:8080", "NODE_EXTRA_CA_CERTS=/etc/corp-ca.pem",
		}
	}})
	srv := h.server("fake", "normal", true)
	srv.Env["MY_TOKEN"] = "given"
	h.m.Update([]config.MCPServer{srv}, 0)
	if st := h.tools("fake"); st.State != StateReady {
		t.Fatalf("state %q (%s)", st.State, st.Detail)
	}
	var env []string
	for _, l := range recorded(t, h.record) {
		if e, ok := strings.CutPrefix(l, "env "); ok {
			env = append(env, e)
		}
	}
	got := strings.Join(env, "\n")
	for _, want := range []string{"HOME=/home/someone", "MY_TOKEN=given", "PATH=", "HTTPS_PROXY=http://proxy.corp:8080",
		"https_proxy=http://proxy.corp:8080", "NODE_EXTRA_CA_CERTS=/etc/corp-ca.pem"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %s", want)
		}
	}
	for _, bad := range []string{"GOBBONET_ACCESS_SECRET", "GOBBONET_LLM_API_KEY", "AWS_SECRET", "BASH_FUNC"} {
		if strings.Contains(got, bad) {
			t.Errorf("%s reached the server", bad)
		}
	}
}

func TestBuildEnvWindowsIgnoresCase(t *testing.T) {
	env := buildEnv("windows", []string{"Path=C:\\Windows", "SystemRoot=C:\\Windows", "GOBBONET_ACCESS_SECRET=x", "UserProfile=C:\\Users\\me"},
		map[string]string{"PATH": "C:\\tools"})
	got := strings.Join(env, ";")
	if !strings.Contains(got, "PATH=C:\\tools") || strings.Contains(got, "Path=C:\\Windows") {
		t.Errorf("the env table should replace Path: %s", got)
	}
	if !strings.Contains(got, "SystemRoot=C:\\Windows") || !strings.Contains(got, "UserProfile=") {
		t.Errorf("SYSTEMROOT and USERPROFILE must pass whatever their case: %s", got)
	}
	if strings.Contains(got, "GOBBONET") {
		t.Error("a GOBBONET_ variable passed")
	}
	if p := buildEnv("windows", []string{"https_proxy=http://p:1"}, nil); len(p) != 1 {
		t.Errorf("the proxy setting, in any case, passes on Windows: %v", p)
	}
}

func TestCallRefusals(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "normal", true), h.server("off", "normal", false)}, 0)

	if _, err := h.call("nope", "echo", `{}`, 0); kindOf(err) != KindUnknownServer {
		t.Errorf("unknown server: %v", err)
	}
	if _, err := h.call("off", "echo", `{}`, 0); kindOf(err) != KindDisabled {
		t.Errorf("switched off: %v", err)
	}
	if _, err := h.call("fake", "rm_rf", `{}`, 0); kindOf(err) != KindUnknownTool {
		t.Errorf("a tool the server does not list: %v", err)
	}
	if _, err := h.call("fake", "echo", `[1,2]`, 0); kindOf(err) != KindBadArgs {
		t.Errorf("arguments that are not an object: %v", err)
	}
	// A switched-off server is never started, not even by a call to it.
	if n := len(h.pids()); n != 1 {
		t.Errorf("%d programs started, want only the enabled one", n)
	}
}

func TestResultIsRenderedAndCut(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "normal", true)}, 0)

	res, err := h.call("fake", "big", `{}`, 1000)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Truncated || len([]rune(res.Text)) != 1000 || res.Chars != 20000 {
		t.Errorf("cut to %d of %d characters, truncated=%v", len([]rune(res.Text)), res.Chars, res.Truncated)
	}
	// Below the floor is held to the floor.
	if res, _ := h.call("fake", "big", `{}`, 10); len([]rune(res.Text)) != MinResultChars {
		t.Errorf("floor: %d", len([]rune(res.Text)))
	}

	res, err = h.call("fake", "mixed", `{}`, 0)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(res.Text, "a picture:") || !strings.Contains(res.Text, "[image (image/png, 3 KB) not shown]") ||
		!strings.Contains(res.Text, "[x.txt: file:///tmp/x.txt]") {
		t.Errorf("rendered: %q", res.Text)
	}
	if strings.Contains(res.Text, "AAAA") {
		t.Error("an image's data reached the text")
	}

	res, err = h.call("fake", "fails", `{}`, 0)
	if err != nil || !res.IsError || res.Text != "no such file" {
		t.Errorf("isError: %+v %v", res, err)
	}
}

// notifications/tools/list_changed makes the next use read the list again.
func TestToolListChanged(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{h.server("fake", "normal", true)}, 0)
	if _, err := h.call("fake", "addtool", `{}`, 0); err != nil {
		t.Fatal(err)
	}
	res, err := h.call("fake", "extra", `{}`, 0)
	if err != nil {
		t.Fatalf("the new tool was not found: %v", err)
	}
	if res.Text != "extra ran" {
		t.Errorf("result %q", res.Text)
	}
}

// Switching a server off, changing it, or removing it stops its program;
// shutting down stops them all.
func TestUpdateAndShutdownStopPrograms(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("process checks use kill(pid, 0)")
	}
	h := newHarness(t, Options{})
	a, b := h.server("a", "normal", true), h.server("b", "normal", true)
	h.m.Update([]config.MCPServer{a, b}, 0)
	h.tools("a")
	if len(h.pids()) != 2 {
		t.Fatalf("pids %v", h.pids())
	}
	before := h.pids()

	// Unchanged tables keep running.
	h.m.Update([]config.MCPServer{a, b}, 0)
	time.Sleep(300 * time.Millisecond)
	for _, p := range before {
		if !alive(p) {
			t.Fatalf("an unchanged server was stopped")
		}
	}

	// b switched off: one of the two goes, and b reports off.
	b.Enabled = false
	h.m.Update([]config.MCPServer{a, b}, 0)
	waitUntil(t, "one program to stop", 10*time.Second, func() bool {
		n := 0
		for _, p := range before {
			if alive(p) {
				n++
			}
		}
		return n == 1
	})
	if st := h.status("b"); st.State != StateOff {
		t.Errorf("b: %q", st.State)
	}
	if _, err := h.call("a", "echo", `{}`, 0); err != nil {
		t.Errorf("a should be unaffected: %v", err)
	}

	h.m.Shutdown()
	for _, p := range h.pids() {
		if alive(p) {
			t.Errorf("pid %d outlived Shutdown", p)
		}
	}
	// And a Manager that has shut down starts nothing.
	h.m.Update([]config.MCPServer{a}, 0)
	if len(h.m.Status()) != 0 {
		t.Error("Update after Shutdown took effect")
	}
}

func TestCommandNotFound(t *testing.T) {
	h := newHarness(t, Options{})
	h.m.Update([]config.MCPServer{{Name: "x", Command: "gobbonet-no-such-program-here", Enabled: true}}, 0)
	st := h.tools("x")
	if st.State != StateFailed || !strings.Contains(st.Detail, "was not found on this PC's PATH") {
		t.Fatalf("%+v", st)
	}
	h.m.Update([]config.MCPServer{{Name: "y", Command: "bin/missing", Enabled: true}}, 0)
	if st := h.tools("y"); !strings.Contains(st.Detail, "There is no program at") {
		t.Fatalf("%+v", st)
	}
}
