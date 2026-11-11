package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

// A server's state, as GET /mcp/tools and /mcp/servers report it.
const (
	StateOff      = "off"      // switched off in config.toml
	StateIdle     = "idle"     // on, and started the first time it is needed
	StateStarting = "starting" // started; waiting for its answer to initialize
	StateReady    = "ready"
	StateFailed   = "failed" // see Detail; tried again on the next use after RetryIn
)

// ProtocolVersion is the MCP version this client asks for. A server that
// speaks another answers with the one it prefers; any in supportedVersions is
// accepted, since the three requests this client makes have not changed shape
// across them.
const ProtocolVersion = "2025-06-18"

var supportedVersions = map[string]bool{
	"2024-11-05": true,
	"2025-03-26": true,
	"2025-06-18": true,
	"2025-11-25": true,
}

const (
	// DefaultStartTimeout bounds a start: launching the program and its
	// answers to initialize and tools/list. Generous, because `npx -y` fetches
	// the package on its first run.
	DefaultStartTimeout = 2 * time.Minute
	// maxBackoff caps the wait before a failed server is tried again, as
	// recoveryLoop caps the engines'.
	maxBackoff = 2 * time.Minute
	// stopGrace is how long a server has to exit by itself once its stdin is
	// closed, MCP's polite stop, before its process group is ended.
	stopGrace = 2 * time.Second

	maxTools       = 256
	maxToolPages   = 32
	maxSchemaBytes = 64 << 10
	maxDescription = 4000

	// The default, floor and ceiling of a result, in characters: the chat
	// page's toolResultMaxChars (CARD_TOOL_LIMITS in js/23-card-code.js).
	DefaultResultChars = 8000
	MinResultChars     = 500
	MaxResultChars     = 100000
)

// Options configure a Manager.
type Options struct {
	// ConfigDir is where a relative command ("bin/server") is found from:
	// the folder config.toml is in.
	ConfigDir string
	// WorkDir is the folder servers run in. The home folder when empty.
	WorkDir string
	// LogDir holds mcp-<name>.log, each server's error output. No logs when
	// empty.
	LogDir string
	// ClientVersion is GobboNet's version, sent in initialize.
	ClientVersion string
	// StartTimeout overrides DefaultStartTimeout (tests).
	StartTimeout time.Duration
	// Environ overrides os.Environ (tests).
	Environ func() []string
}

// Tool is one tool a server offers, as GET /mcp/tools reports it.
type Tool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title,omitempty"`
	Description string          `json:"description,omitempty"`
	InputSchema json.RawMessage `json:"input_schema"`
	Annotations *Annotations    `json:"annotations,omitempty"`
	// ReadOnly is the server's readOnlyHint, and only that. It is a hint
	// from the program, so the chat page uses it for one thing: whether
	// "Ask for tools that change things" asks. The default asks regardless.
	ReadOnly bool `json:"read_only"`
}

// Annotations are MCP's tool hints. Untrusted, as the spec says: they come
// from the program and describe what it claims the tool does.
type Annotations struct {
	Title           string `json:"title,omitempty"`
	ReadOnlyHint    *bool  `json:"readOnlyHint,omitempty"`
	DestructiveHint *bool  `json:"destructiveHint,omitempty"`
	IdempotentHint  *bool  `json:"idempotentHint,omitempty"`
	OpenWorldHint   *bool  `json:"openWorldHint,omitempty"`
}

// Implementation is a server's name and version from initialize.
type Implementation struct {
	Name    string `json:"name"`
	Version string `json:"version,omitempty"`
	Title   string `json:"title,omitempty"`
}

// Status is one server as the routes report it.
type Status struct {
	Name     string          `json:"name"`
	Enabled  bool            `json:"enabled"`
	State    string          `json:"state"`
	Detail   string          `json:"detail,omitempty"`
	RetryIn  int             `json:"retry_in_seconds,omitempty"`
	Server   *Implementation `json:"server,omitempty"`
	Tools    []Tool          `json:"tools"`
	NumTools int             `json:"tool_count"`
}

// Result is a finished tools/call.
type Result struct {
	Server    string `json:"server"`
	Tool      string `json:"tool"`
	Text      string `json:"text"`
	IsError   bool   `json:"is_error"`
	Truncated bool   `json:"truncated"`
	Chars     int    `json:"chars"` // before truncation
	MS        int64  `json:"ms"`
}

// What went wrong with a call, for the HTTP status and the page's wording.
const (
	KindUnknownServer = "unknown_server"
	KindDisabled      = "disabled"
	KindUnknownTool   = "unknown_tool"
	KindBadArgs       = "bad_arguments"
	KindUnavailable   = "unavailable"
	KindTimeout       = "timeout"
	KindRefused       = "refused"
	KindCancelled     = "cancelled"
)

// Error is a call that did not produce a result.
type Error struct {
	Kind string
	Msg  string
}

func (e *Error) Error() string { return e.Msg }

func errorf(kind, format string, args ...any) *Error {
	return &Error{Kind: kind, Msg: fmt.Sprintf(format, args...)}
}

var errStopped = errors.New("GobboNet stopped the server")

// Manager owns every MCP server: their programs, their sessions, and their
// tool lists. Servers start the first time something needs them -- a tool
// list or a call -- and run until they are switched off, changed, or GobboNet
// stops. One that stops by itself is started again on the next use, with a
// wait that doubles after each failure.
type Manager struct {
	opts Options

	mu          sync.Mutex
	servers     []*server
	callTimeout time.Duration
	closed      bool
	wg          sync.WaitGroup

	// logMu, not mu: a log is opened while Update holds mu.
	logMu sync.Mutex
	logs  map[string]*logWriter
}

// NewManager makes a Manager with no servers; Update gives it some.
func NewManager(opts Options) *Manager {
	if opts.StartTimeout <= 0 {
		opts.StartTimeout = DefaultStartTimeout
	}
	if opts.Environ == nil {
		opts.Environ = os.Environ
	}
	if opts.WorkDir == "" {
		if h, err := os.UserHomeDir(); err == nil {
			opts.WorkDir = h
		}
	}
	if opts.ClientVersion == "" {
		opts.ClientVersion = "dev"
	}
	return &Manager{opts: opts, callTimeout: time.Duration(config.DefaultMCPCallTimeoutSeconds) * time.Second, logs: map[string]*logWriter{}}
}

// Update makes the servers those in list. A server whose table is unchanged
// keeps running; one that changed, or is gone, is stopped. Nothing is
// started here.
func (m *Manager) Update(list []config.MCPServer, callTimeout time.Duration) {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	if callTimeout > 0 {
		m.callTimeout = callTimeout
	}
	old := map[string]*server{}
	for _, s := range m.servers {
		old[s.cfg.Name] = s
	}
	var next, retire []*server
	for _, c := range list {
		if s, ok := old[c.Name]; ok {
			delete(old, c.Name)
			if s.cfg.Equal(c) {
				next = append(next, s)
				continue
			}
			retire = append(retire, s)
		}
		next = append(next, m.newServer(c))
	}
	for _, s := range old {
		retire = append(retire, s)
	}
	m.servers = next
	m.mu.Unlock()
	for _, s := range retire {
		s.retire()
	}
}

// Servers is the tables the Manager has, in config order.
func (m *Manager) Servers() []config.MCPServer {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]config.MCPServer, len(m.servers))
	for i, s := range m.servers {
		out[i] = s.cfg
	}
	return out
}

// CallTimeout is how long one call may run.
func (m *Manager) CallTimeout() time.Duration {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.callTimeout
}

// List is every server's table and status, read together, without starting
// any.
func (m *Manager) List() ([]config.MCPServer, []Status) {
	list := m.list()
	cfgs, sts := make([]config.MCPServer, len(list)), make([]Status, len(list))
	for i, s := range list {
		cfgs[i], sts[i] = s.cfg, s.status()
	}
	return cfgs, sts
}

// Status reports every server without starting any.
func (m *Manager) Status() []Status {
	list := m.list()
	out := make([]Status, len(list))
	for i, s := range list {
		out[i] = s.status()
	}
	return out
}

// Tools starts every enabled server that is not running, waits for each
// until ctx ends, and reports them all with their tools. refresh asks each
// running server for its list again.
func (m *Manager) Tools(ctx context.Context, refresh bool) []Status {
	list := m.list()
	var wg sync.WaitGroup
	for _, s := range list {
		if !s.cfg.Enabled {
			continue
		}
		wg.Add(1)
		go func(s *server) {
			defer wg.Done()
			s.refreshTools(ctx, refresh)
		}(s)
	}
	wg.Wait()
	out := make([]Status, len(list))
	for i, s := range list {
		out[i] = s.status()
	}
	return out
}

// Call runs one tool. args is the tool's arguments, a JSON object. The text
// that comes back is cut to maxChars characters (0 for the default).
func (m *Manager) Call(ctx context.Context, name, tool string, args json.RawMessage, maxChars int) (*Result, error) {
	s := m.lookup(name)
	if s == nil {
		return nil, errorf(KindUnknownServer, "There is no MCP server called %q.", name)
	}
	if !s.cfg.Enabled {
		return nil, errorf(KindDisabled, "The MCP server %q is switched off.", name)
	}
	args, err := objectArgs(args)
	if err != nil {
		return nil, err
	}
	startCtx, cancel := context.WithTimeout(ctx, m.opts.StartTimeout)
	c, err := s.ensure(startCtx)
	cancel()
	if err != nil {
		return nil, s.unavailable(ctx, err)
	}
	if !s.hasTool(tool) {
		// The list may have changed since it was read; ask once more.
		listCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		s.refreshTools(listCtx, true)
		cancel()
		if !s.hasTool(tool) {
			return nil, errorf(KindUnknownTool, "The MCP server %q has no tool called %q.", name, tool)
		}
	}
	if maxChars <= 0 {
		maxChars = DefaultResultChars
	}
	maxChars = min(MaxResultChars, max(MinResultChars, maxChars))

	timeout := m.CallTimeout()
	callCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	began := time.Now()
	var res callResult
	err = c.call(callCtx, "tools/call", map[string]any{"name": tool, "arguments": args}, &res, true)
	ms := time.Since(began).Milliseconds()
	if err != nil {
		var rpc *RPCError
		switch {
		case ctx.Err() != nil:
			s.logw.logf("[gobbonet] call %s: abandoned after %d ms (the request ended)", tool, ms)
			return nil, errorf(KindCancelled, "The call to %s was abandoned.", tool)
		case callCtx.Err() != nil:
			s.logw.logf("[gobbonet] call %s: timed out after %d ms", tool, ms)
			return nil, errorf(KindTimeout, "%s took longer than %s, so it was cancelled (mcp_call_timeout_seconds).", tool, timeout)
		case errors.As(err, &rpc):
			s.logw.logf("[gobbonet] call %s: refused after %d ms: %s", tool, ms, clip(rpc.Message, 300))
			return nil, errorf(KindRefused, "%s: %s", tool, clip(rpc.Message, 500))
		default:
			s.logw.logf("[gobbonet] call %s: failed after %d ms: %v", tool, ms, err)
			return nil, errorf(KindUnavailable, "The MCP server %q stopped during the call: %v", name, err)
		}
	}
	text := res.render()
	out := &Result{Server: name, Tool: tool, IsError: res.IsError, MS: ms}
	out.Chars = len([]rune(text))
	out.Text, out.Truncated = cutRunes(text, maxChars)
	verdict := "ok"
	if res.IsError {
		verdict = "the tool reported an error"
	}
	// What a call was and how long it took, never what it was given or what
	// it returned: those are the user's.
	s.logw.logf("[gobbonet] call %s: %s, %d ms, %d characters", tool, verdict, ms, out.Chars)
	return out, nil
}

// Shutdown stops every server and waits, up to a limit, for them to go.
func (m *Manager) Shutdown() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	list := m.servers
	m.servers = nil
	m.mu.Unlock()
	for _, s := range list {
		s.retire()
	}
	done := make(chan struct{})
	go func() {
		m.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		log.Printf("[mcp] an MCP server did not stop within 15s")
	}
	m.logMu.Lock()
	for _, l := range m.logs {
		l.close()
	}
	m.logMu.Unlock()
}

func (m *Manager) list() []*server {
	m.mu.Lock()
	defer m.mu.Unlock()
	return append([]*server(nil), m.servers...)
}

func (m *Manager) lookup(name string) *server {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, s := range m.servers {
		if s.cfg.Name == name {
			return s
		}
	}
	return nil
}

func (m *Manager) newServer(c config.MCPServer) *server {
	s := &server{m: m, cfg: c, state: StateOff, logw: m.logFor(c.Name)}
	if c.Enabled {
		s.state = StateIdle
	}
	return s
}

// track registers a server's watcher with Shutdown. false once shutting down.
func (m *Manager) track() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return false
	}
	m.wg.Add(1)
	return true
}

// logFor is the log for a server name, shared by every run of that name in
// this process. The first opening truncates it, as llama-server.log is: a log
// holds this run.
func (m *Manager) logFor(name string) *logWriter {
	m.logMu.Lock()
	defer m.logMu.Unlock()
	if l := m.logs[name]; l != nil {
		return l
	}
	l := &logWriter{}
	if m.opts.LogDir != "" {
		if err := os.MkdirAll(m.opts.LogDir, 0o700); err == nil {
			f, err := os.OpenFile(filepath.Join(m.opts.LogDir, "mcp-"+name+".log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
			if err == nil {
				l.f = f
			} else {
				log.Printf("[mcp:%s] no log file: %v", name, err)
			}
		}
	}
	m.logs[name] = l
	return l
}

// resolve finds the program a command names.
func (m *Manager) resolve(command string) (string, error) {
	seps := "/"
	if runtime.GOOS == "windows" {
		seps = `/\`
	}
	path := command
	switch {
	case filepath.IsAbs(command):
	case strings.ContainsAny(command, seps):
		path = filepath.Join(m.opts.ConfigDir, command)
	default:
		p, err := exec.LookPath(command)
		if err != nil {
			return "", fmt.Errorf("%q was not found on this PC's PATH. Install it, or give its full path as the command", command)
		}
		return p, nil
	}
	st, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("There is no program at %s", path)
	}
	if st.IsDir() {
		return "", fmt.Errorf("%s is a folder, not a program", path)
	}
	return path, nil
}

// server is one MCP server's run state.
type server struct {
	m    *Manager
	cfg  config.MCPServer
	logw *logWriter

	mu       sync.Mutex
	state    string
	detail   string
	gen      uint64
	retired  bool
	conn     *conn
	starting chan struct{}
	tools    []Tool
	stale    bool
	info     *Implementation
	failures int
	retryAt  time.Time
}

func (s *server) tag() string  { return "[mcp:" + s.cfg.Name + "]" }
func (s *server) what() string { return fmt.Sprintf("the MCP server %q", s.cfg.Name) }

func backoff(failures int) time.Duration {
	d := time.Second
	for i := 1; i < failures && d < maxBackoff; i++ {
		d *= 2
	}
	return min(d, maxBackoff)
}

func (s *server) status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := Status{Name: s.cfg.Name, Enabled: s.cfg.Enabled, State: s.state, Detail: s.detail, Tools: []Tool{}}
	if s.state == StateFailed {
		if wait := time.Until(s.retryAt); wait > 0 {
			st.RetryIn = int(wait.Round(time.Second) / time.Second)
			if st.RetryIn == 0 {
				st.RetryIn = 1
			}
		}
	}
	if s.state == StateReady {
		st.Server = s.info
		st.Tools = append(st.Tools, s.tools...)
	}
	st.NumTools = len(st.Tools)
	return st
}

func (s *server) hasTool(name string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stale {
		return false
	}
	for _, t := range s.tools {
		if t.Name == name {
			return true
		}
	}
	return false
}

// ensure returns the server's session, starting the program if it is not
// running and waiting for it until ctx ends.
func (s *server) ensure(ctx context.Context) (*conn, error) {
	for {
		s.mu.Lock()
		if s.retired || !s.cfg.Enabled {
			s.mu.Unlock()
			return nil, errorf(KindDisabled, "The MCP server %q is switched off.", s.cfg.Name)
		}
		switch s.state {
		case StateReady:
			c := s.conn
			s.mu.Unlock()
			return c, nil
		case StateStarting:
			ch := s.starting
			s.mu.Unlock()
			select {
			case <-ch:
				continue
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		case StateFailed:
			if wait := time.Until(s.retryAt); wait > 0 {
				d := s.detail
				s.mu.Unlock()
				return nil, fmt.Errorf("%s (tried again in %s)", strings.TrimSuffix(d, "."), wait.Round(time.Second))
			}
		}
		s.gen++
		gen := s.gen
		s.state, s.detail = StateStarting, ""
		s.starting = make(chan struct{})
		done := s.starting
		s.mu.Unlock()
		go s.start(gen, done)
	}
}

// unavailable turns a failure to get a session into a call error.
func (s *server) unavailable(ctx context.Context, err error) error {
	var e *Error
	switch {
	case errors.As(err, &e):
		return e
	case ctx.Err() != nil:
		return errorf(KindCancelled, "The call was abandoned while %s was starting.", s.what())
	case errors.Is(err, context.DeadlineExceeded):
		return errorf(KindUnavailable, "The MCP server %q is still starting after %s.", s.cfg.Name, s.m.opts.StartTimeout)
	}
	return errorf(KindUnavailable, "The MCP server %q is not available: %v", s.cfg.Name, err)
}

var errSuperseded = errors.New("superseded")

func (s *server) start(gen uint64, done chan struct{}) {
	defer close(done)
	if err := s.launch(gen); err != nil && !errors.Is(err, errSuperseded) {
		s.mu.Lock()
		if s.gen == gen && s.state == StateStarting {
			s.failLocked(err.Error())
		}
		s.mu.Unlock()
	}
}

// failLocked records a failure. Caller holds s.mu.
func (s *server) failLocked(detail string) {
	s.state = StateFailed
	s.detail = detail
	s.failures++
	s.retryAt = time.Now().Add(backoff(s.failures))
	s.tools, s.info, s.conn = nil, nil, nil
	s.logw.logf("[gobbonet] %s", detail)
	log.Printf("%s %s", s.tag(), detail)
}

type initializeResult struct {
	ProtocolVersion string `json:"protocolVersion"`
	Capabilities    struct {
		Tools *struct {
			ListChanged bool `json:"listChanged"`
		} `json:"tools"`
	} `json:"capabilities"`
	ServerInfo Implementation `json:"serverInfo"`
}

func (s *server) launch(gen uint64) error {
	path, err := s.m.resolve(s.cfg.Command)
	if err != nil {
		return err
	}
	cmd := exec.Command(path, s.cfg.Args...)
	cmd.Env = buildEnv(runtime.GOOS, s.m.opts.Environ(), s.cfg.Env)
	cmd.Dir = s.m.opts.WorkDir

	// Pipes made here rather than with cmd.StdinPipe and friends: with *os.File
	// stdio, Wait waits for the program and not for a copy, so its exit is
	// seen even when a helper it started still holds the pipes open.
	inR, inW, err := os.Pipe()
	if err != nil {
		return err
	}
	outR, outW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		return err
	}
	errR, errW, err := os.Pipe()
	if err != nil {
		inR.Close()
		inW.Close()
		outR.Close()
		outW.Close()
		return err
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = inR, outW, errW
	s.logw.logf("[gobbonet] starting %s %s", path, strings.Join(quoteArgs(s.cfg.Args), " "))
	child, err := supervisor.StartChild(cmd, s.tag(), s.what())
	inR.Close()
	outW.Close()
	errW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		errR.Close()
		return err
	}
	tail := &tailLines{}
	go copyStderr(errR, s.logw, tail)
	c := newConn(outR, inW, s.notifyFunc(gen), s.logw.logf)

	if !s.m.track() {
		c.close(errStopped)
		stopChild(child)
		return errSuperseded
	}
	go s.watch(gen, child, c, tail)

	s.mu.Lock()
	if s.gen != gen || s.retired {
		s.mu.Unlock()
		c.close(errStopped)
		return errSuperseded
	}
	s.conn = c
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), s.m.opts.StartTimeout)
	defer cancel()
	failed := func(step string, err error) error {
		why := err.Error()
		if errors.Is(err, context.DeadlineExceeded) {
			why = fmt.Sprintf("no answer within %s. Is it an MCP server that talks over stdin and stdout?", s.m.opts.StartTimeout)
		} else if gone := exitDetail(child, tail); gone != "" {
			why = gone
		}
		c.close(fmt.Errorf("%s", why))
		return fmt.Errorf("Could not %s: %s", step, why)
	}

	var init initializeResult
	err = c.call(ctx, "initialize", map[string]any{
		"protocolVersion": ProtocolVersion,
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]any{"name": "GobboNet", "version": s.m.opts.ClientVersion},
	}, &init, false)
	if err != nil {
		return failed("start it", err)
	}
	if !supportedVersions[init.ProtocolVersion] {
		c.close(errStopped)
		return fmt.Errorf("It speaks MCP version %q, which GobboNet does not; it supports %s", clip(init.ProtocolVersion, 40), ProtocolVersion)
	}
	if err := c.notify("notifications/initialized", nil); err != nil {
		return failed("start it", err)
	}
	tools, err := listTools(ctx, c, s.logw)
	if err != nil {
		return failed("read its tools", err)
	}
	info := cleanImplementation(init.ServerInfo)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gen != gen || s.retired {
		c.close(errStopped)
		return errSuperseded
	}
	s.state, s.detail = StateReady, ""
	if init.Capabilities.Tools == nil && len(tools) == 0 {
		s.detail = "It offers no tools."
	}
	s.tools, s.stale, s.info, s.failures = tools, false, info, 0
	s.logw.logf("[gobbonet] ready: %s %s, MCP %s, %d tools", info.Name, info.Version, init.ProtocolVersion, len(tools))
	log.Printf("%s ready: %d tools", s.tag(), len(tools))
	return nil
}

// watch waits for the program to end or its session to fail, then makes sure
// nothing of it is left running. It is the only place a server's process is
// stopped, so every way out -- a crash, a protocol error, a stop -- ends the
// same way.
func (s *server) watch(gen uint64, child *supervisor.Child, c *conn, tail *tailLines) {
	defer s.m.wg.Done()
	select {
	case <-child.Exited():
	case <-c.Done():
	}
	c.close(errStopped)
	select {
	case <-child.Exited():
	case <-time.After(stopGrace):
	}
	stopChild(child)
	if err := c.Err(); err != errStopped {
		s.logw.logf("[gobbonet] session ended: %v", err)
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.gen == gen && s.state == StateReady && !s.retired {
		why := exitDetail(child, tail)
		if why == "" {
			why = c.Err().Error()
		}
		s.failLocked("It stopped unexpectedly: " + why)
	}
}

func stopChild(child *supervisor.Child) {
	if err := child.Stop(); err != nil {
		log.Printf("[mcp] %v", err)
	}
}

// exitDetail describes a program that has exited -- how, and the last thing
// it printed -- or "" if it is still running.
func exitDetail(child *supervisor.Child, tail *tailLines) string {
	select {
	case <-child.Exited():
	case <-time.After(300 * time.Millisecond):
		return ""
	}
	how := "it exited"
	if err := child.ExitErr(); err != nil {
		how = "it exited (" + err.Error() + ")"
	}
	if last := tail.last(); last != "" {
		how += ": " + last
	}
	return how
}

// retire stops the server for good: it was switched off, changed, removed,
// or GobboNet is stopping.
func (s *server) retire() {
	s.mu.Lock()
	s.retired = true
	s.gen++
	c := s.conn
	s.conn, s.tools, s.info = nil, nil, nil
	s.state, s.detail = StateOff, ""
	s.mu.Unlock()
	if c != nil {
		c.close(errStopped)
	}
}

func (s *server) notifyFunc(gen uint64) func(string, json.RawMessage) {
	return func(method string, params json.RawMessage) {
		switch method {
		case "notifications/tools/list_changed":
			s.mu.Lock()
			if s.gen == gen {
				s.stale = true
			}
			s.mu.Unlock()
		case "notifications/message":
			var p struct {
				Level string          `json:"level"`
				Data  json.RawMessage `json:"data"`
			}
			if json.Unmarshal(params, &p) == nil {
				s.logw.logf("[%s] %s", p.Level, clip(string(p.Data), 1000))
			}
		}
	}
}

// refreshTools makes sure the server is running and its tool list current.
func (s *server) refreshTools(ctx context.Context, force bool) {
	c, err := s.ensure(ctx)
	if err != nil {
		return
	}
	s.mu.Lock()
	need := force || s.stale
	gen := s.gen
	s.mu.Unlock()
	if !need {
		return
	}
	tools, err := listTools(ctx, c, s.logw)
	if err != nil {
		s.logw.logf("[gobbonet] could not read the tool list again: %v", err)
		return
	}
	s.mu.Lock()
	if s.gen == gen && s.state == StateReady {
		s.tools, s.stale = tools, false
	}
	s.mu.Unlock()
}

type rawTool struct {
	Name        string          `json:"name"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
	Annotations *Annotations    `json:"annotations"`
}

// listTools reads a server's whole tool list, page by page.
func listTools(ctx context.Context, c *conn, logw *logWriter) ([]Tool, error) {
	var out []Tool
	seen := map[string]bool{}
	cursor := ""
	for page := 0; page < maxToolPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var res struct {
			Tools      []rawTool `json:"tools"`
			NextCursor string    `json:"nextCursor"`
		}
		if err := c.call(ctx, "tools/list", params, &res, true); err != nil {
			var rpc *RPCError
			if page == 0 && errors.As(err, &rpc) && rpc.Code == codeMethodNotFound {
				return []Tool{}, nil // a server with no tools at all
			}
			return nil, err
		}
		for _, t := range res.Tools {
			tool, why := cleanTool(t)
			if why != "" {
				logw.logf("[gobbonet] left out a tool: %s", why)
				continue
			}
			if seen[tool.Name] {
				continue
			}
			seen[tool.Name] = true
			out = append(out, tool)
			if len(out) >= maxTools {
				logw.logf("[gobbonet] only the first %d tools are used", maxTools)
				return out, nil
			}
		}
		if res.NextCursor == "" {
			break
		}
		cursor = res.NextCursor
	}
	if out == nil {
		out = []Tool{}
	}
	return out, nil
}

// cleanTool checks one tool from a server and bounds what it may say. why is
// the reason it is left out, or "".
func cleanTool(t rawTool) (Tool, string) {
	if t.Name == "" || len([]rune(t.Name)) > 128 || badText(t.Name) {
		return Tool{}, fmt.Sprintf("a name that is empty, over 128 characters or holds control characters (%q)", clip(t.Name, 40))
	}
	schema := t.InputSchema
	if len(schema) == 0 || string(schema) == "null" {
		schema = json.RawMessage(`{"type":"object"}`)
	}
	if len(schema) > maxSchemaBytes {
		return Tool{}, fmt.Sprintf("%s: its input schema is over %d KB", t.Name, maxSchemaBytes>>10)
	}
	var probe map[string]any
	if json.Unmarshal(schema, &probe) != nil {
		return Tool{}, fmt.Sprintf("%s: its input schema is not a JSON object", t.Name)
	}
	out := Tool{
		Name:        t.Name,
		Title:       clip(t.Title, 200),
		Description: clip(t.Description, maxDescription),
		InputSchema: schema,
		Annotations: t.Annotations,
	}
	if a := t.Annotations; a != nil {
		a.Title = clip(a.Title, 200)
		out.ReadOnly = a.ReadOnlyHint != nil && *a.ReadOnlyHint
	}
	return out, ""
}

func cleanImplementation(i Implementation) *Implementation {
	return &Implementation{Name: clip(i.Name, 100), Version: clip(i.Version, 60), Title: clip(i.Title, 100)}
}

func badText(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// objectArgs checks a call's arguments: a JSON object, or nothing.
func objectArgs(raw json.RawMessage) (json.RawMessage, error) {
	t := strings.TrimSpace(string(raw))
	if t == "" || t == "null" {
		return json.RawMessage(`{}`), nil
	}
	var probe map[string]any
	if json.Unmarshal([]byte(t), &probe) != nil {
		return nil, errorf(KindBadArgs, "A tool's arguments must be a JSON object.")
	}
	return json.RawMessage(t), nil
}

func quoteArgs(args []string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		if a == "" || strings.ContainsAny(a, " \t\"'") {
			out[i] = fmt.Sprintf("%q", a)
		} else {
			out[i] = a
		}
	}
	return out
}
