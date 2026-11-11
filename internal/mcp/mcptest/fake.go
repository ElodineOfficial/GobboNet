// Package mcptest is a fake MCP server for tests (1.8.0, #16). It is linked
// only into test binaries: nothing outside a _test.go file imports it.
//
// A test binary runs the fake instead of its tests when GOBBONET_FAKE_MCP is
// set; call Main first thing in TestMain. A Manager then starts the fake as
// it would start any server -- the test binary as the command -- so the tests
// go through the real process handling, pipes and protocol, with nothing
// mocked.
//
// GOBBONET_FAKE_MCP is passed in the server's env table, the way a user's own
// variables reach a server; nothing else of the test's environment does.
//
// Modes:
//
//	normal      a working server (see tools)
//	exit        writes a line to stderr and exits 2 before answering
//	silent      reads requests and never answers
//	oldversion  answers initialize with a protocol version nobody speaks
//	notools     declares no tools capability and knows no tools/list
//
// FAKE_MCP_RECORD names a file it appends what it saw to: its pid, its
// environment, each method, and each cancellation.
package mcptest

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

// Main runs the fake and exits if this process was started as one.
func Main() {
	if mode := os.Getenv("GOBBONET_FAKE_MCP"); mode != "" {
		runFakeServer(mode)
		os.Exit(0)
	}
}

type fakeServer struct {
	out    *bufio.Writer
	outMu  sync.Mutex
	record *os.File
	nextID int
	extra  bool // "addtool" has added the tool "extra"

	mu      sync.Mutex
	waiting map[string]chan json.RawMessage // our requests to the client, by id
}

func (f *fakeServer) send(v any) {
	raw, _ := json.Marshal(v)
	f.outMu.Lock()
	f.out.Write(raw)
	f.out.WriteByte('\n')
	f.out.Flush()
	f.outMu.Unlock()
}

func (f *fakeServer) note(format string, args ...any) {
	if f.record != nil {
		fmt.Fprintf(f.record, format+"\n", args...)
	}
}

// ask sends a request to the client and waits for its answer.
func (f *fakeServer) ask(method string) json.RawMessage {
	f.mu.Lock()
	f.nextID++
	id := fmt.Sprintf("srv-%d", f.nextID)
	ch := make(chan json.RawMessage, 1)
	f.waiting[id] = ch
	f.mu.Unlock()
	f.send(map[string]any{"jsonrpc": "2.0", "id": id, "method": method})
	select {
	case r := <-ch:
		return r
	case <-time.After(5 * time.Second):
		return nil
	}
}

func (f *fakeServer) tools(page int) ([]map[string]any, string) {
	all := []map[string]any{
		{"name": "echo", "description": "Echo the arguments back.",
			"inputSchema": map[string]any{"type": "object", "properties": map[string]any{"text": map[string]any{"type": "string"}}},
			"annotations": map[string]any{"readOnlyHint": true}},
		{"name": "slow", "description": "Never finishes.", "inputSchema": map[string]any{"type": "object"}},
		{"name": "crash", "description": "Exits.", "inputSchema": map[string]any{"type": "object"},
			"annotations": map[string]any{"destructiveHint": true}},
		{"name": "big", "description": "Returns a lot.", "inputSchema": map[string]any{"type": "object"}},
		{"name": "mixed", "description": "Text and an image.", "inputSchema": map[string]any{"type": "object"}},
		{"name": "fails", "description": "Reports an error.", "inputSchema": map[string]any{"type": "object"}},
		{"name": "addtool", "description": "Adds the tool extra.", "inputSchema": map[string]any{"type": "object"}},
		{"name": "bad\nname"},
	}
	f.mu.Lock()
	extra := f.extra
	f.mu.Unlock()
	if extra {
		all = append(all, map[string]any{"name": "extra", "inputSchema": map[string]any{"type": "object"}})
	}
	// Two pages, to exercise nextCursor.
	if page == 0 {
		return all[:3], "page-2"
	}
	return all[3:], ""
}

func runFakeServer(mode string) {
	f := &fakeServer{out: bufio.NewWriter(os.Stdout), waiting: map[string]chan json.RawMessage{}}
	if p := os.Getenv("FAKE_MCP_RECORD"); p != "" {
		f.record, _ = os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	}
	f.note("pid %d", os.Getpid())
	env := os.Environ()
	sort.Strings(env)
	for _, e := range env {
		f.note("env %s", e)
	}
	if mode == "exit" {
		fmt.Fprintln(os.Stderr, "starting up")
		fmt.Fprintln(os.Stderr, "fatal: config missing")
		os.Exit(2)
	}
	// Some real servers print a banner on stdout, which MCP forbids.
	fmt.Fprintln(f.out, "Fake MCP server v0 listening on stdio")
	f.out.Flush()

	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 1<<20), 1<<24)
	for in.Scan() {
		var m struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
			Result json.RawMessage `json:"result"`
		}
		if json.Unmarshal(in.Bytes(), &m) != nil {
			continue
		}
		if m.Method == "" {
			// An answer to one of our requests.
			var id string
			json.Unmarshal(m.ID, &id)
			f.mu.Lock()
			ch := f.waiting[id]
			f.mu.Unlock()
			if ch != nil {
				ch <- m.Result
			}
			continue
		}
		f.note("method %s", m.Method)
		if mode == "silent" {
			continue
		}
		if len(m.ID) == 0 {
			if m.Method == "notifications/cancelled" {
				var p struct {
					RequestID json.RawMessage `json:"requestId"`
				}
				json.Unmarshal(m.Params, &p)
				f.note("cancelled %s", p.RequestID)
			}
			continue
		}
		go f.handle(mode, m.ID, m.Method, m.Params)
	}
}

func (f *fakeServer) reply(id json.RawMessage, result any) {
	f.send(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
}

func (f *fakeServer) handle(mode string, id json.RawMessage, method string, params json.RawMessage) {
	switch method {
	case "initialize":
		// A server may ping before it answers. The client must answer, or
		// this start would never finish.
		pong := f.ask("ping")
		f.note("pong %s", pong)
		// And ask for something the client does not offer.
		f.ask("roots/list")
		version := "2025-06-18"
		caps := map[string]any{"tools": map[string]any{"listChanged": true}}
		switch mode {
		case "oldversion":
			version = "1999-01-01"
		case "notools":
			caps = map[string]any{}
		}
		f.reply(id, map[string]any{"protocolVersion": version, "capabilities": caps,
			"serverInfo": map[string]any{"name": "fake-mcp", "version": "0.1"}})
	case "tools/list":
		if mode == "notools" {
			f.send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "no such method"}})
			return
		}
		var p struct {
			Cursor string `json:"cursor"`
		}
		json.Unmarshal(params, &p)
		page := 0
		if p.Cursor == "page-2" {
			page = 1
		}
		tools, next := f.tools(page)
		res := map[string]any{"tools": tools}
		if next != "" {
			res["nextCursor"] = next
		}
		f.reply(id, res)
	case "tools/call":
		var p struct {
			Name      string          `json:"name"`
			Arguments json.RawMessage `json:"arguments"`
		}
		json.Unmarshal(params, &p)
		switch p.Name {
		case "echo":
			f.reply(id, map[string]any{"content": []any{map[string]any{"type": "text", "text": "echo: " + string(p.Arguments)}}})
		case "slow":
			// Never answers; the client has to give up and say so.
		case "crash":
			fmt.Fprintln(os.Stderr, "boom: the tool fell over")
			os.Exit(3)
		case "big":
			f.reply(id, map[string]any{"content": []any{map[string]any{"type": "text", "text": strings.Repeat("é", 20000)}}})
		case "mixed":
			f.reply(id, map[string]any{"content": []any{
				map[string]any{"type": "text", "text": "a picture:"},
				map[string]any{"type": "image", "mimeType": "image/png", "data": strings.Repeat("A", 4096)},
				map[string]any{"type": "resource_link", "uri": "file:///tmp/x.txt", "name": "x.txt"},
			}})
		case "fails":
			f.reply(id, map[string]any{"isError": true, "content": []any{map[string]any{"type": "text", "text": "no such file"}}})
		case "addtool":
			f.mu.Lock()
			f.extra = true
			f.mu.Unlock()
			f.send(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
			f.reply(id, map[string]any{"content": []any{map[string]any{"type": "text", "text": "added"}}})
		case "extra":
			f.reply(id, map[string]any{"content": []any{map[string]any{"type": "text", "text": "extra ran"}}})
		default:
			f.send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32602, "message": "unknown tool " + p.Name}})
		}
	default:
		f.send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "no such method"}})
	}
}

// --- for the tests ----------------------------------------------------------

// Server is a table that starts the fake in mode, recording to record ("" for
// no record).
func Server(t testing.TB, name, mode, record string, enabled bool) config.MCPServer {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"GOBBONET_FAKE_MCP": mode}
	if record != "" {
		env["FAKE_MCP_RECORD"] = record
	}
	return config.MCPServer{Name: name, Command: exe, Args: []string{"-test.run=^$"}, Env: env, Enabled: enabled}
}

// Recorded reads what the fake wrote to its record file.
func Recorded(path string) []string {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	return strings.Split(strings.TrimSpace(string(raw)), "\n")
}
