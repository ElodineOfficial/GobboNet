package config

import (
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// [[mcp_server]] tables (1.8.0, #16).

const mcpTables = `
[[mcp_server]]
name = "files"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\me\\My Documents"]
enabled = true

# The token lives in a sub-table, which TOML allows.
[[mcp_server]]
name = "notes-db"
command = "/opt/notes/bin/mcp"
[mcp_server.env]
NOTES_TOKEN = "abc123"
`

func TestMCPTablesLoad(t *testing.T) {
	path := writeConfig(t, editFile+mcpTables)
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.MCPServers) != 2 {
		t.Fatalf("%d servers", len(cfg.MCPServers))
	}
	f := cfg.MCPServers[0]
	if f.Name != "files" || f.Command != "npx" || !f.Enabled || len(f.Args) != 3 || f.Args[2] != `C:\Users\me\My Documents` {
		t.Errorf("files: %+v", f)
	}
	n := cfg.MCPServers[1]
	if n.Enabled {
		t.Error("enabled must default to false")
	}
	if n.Env["NOTES_TOKEN"] != "abc123" {
		t.Errorf("env: %v", n.Env)
	}
	if cfg.MCPCallTimeoutSeconds != DefaultMCPCallTimeoutSeconds {
		t.Errorf("mcp_call_timeout_seconds %d", cfg.MCPCallTimeoutSeconds)
	}
	if m, ok := cfg.MCPServer("notes-db"); !ok || m.Command != "/opt/notes/bin/mcp" {
		t.Error("MCPServer lookup")
	}
}

func TestMCPTablesRefused(t *testing.T) {
	for name, tc := range map[string]struct{ body, want string }{
		"no name":         {"[[mcp_server]]\ncommand = \"x\"\n", "needs a name"},
		"bad name":        {"[[mcp_server]]\nname = \"My Files\"\ncommand = \"x\"\n", "lowercase letters"},
		"no command":      {"[[mcp_server]]\nname = \"a\"\n", "command is required"},
		"padded command":  {"[[mcp_server]]\nname = \"a\"\ncommand = \"npx -y thing\"\n", ""},
		"spaces around":   {"[[mcp_server]]\nname = \"a\"\ncommand = \" npx\"\n", "put arguments in args"},
		"duplicate":       {"[[mcp_server]]\nname = \"a\"\ncommand = \"x\"\n[[mcp_server]]\nname = \"a\"\ncommand = \"y\"\n", "each needs its own name"},
		"bad env name":    {"[[mcp_server]]\nname = \"a\"\ncommand = \"x\"\nenv = { \"BAD-NAME\" = \"1\" }\n", "env name"},
		"typo in a table": {"[[mcp_server]]\nname = \"a\"\ncomand = \"x\"\n", "did you mean mcp_server.command"},
		"misplaced key":   {"[[mcp_server]]\nname = \"a\"\ncommand = \"x\"\nlisten_port = 9000\n", "above the first [[mcp_server]] table"},
		"wrong type":      {"[[mcp_server]]\nname = \"a\"\ncommand = \"x\"\nargs = \"-y thing\"\n", "args"},
		"timeout range":   {"mcp_call_timeout_seconds = 0\n", ""},
		"timeout high":    {"mcp_call_timeout_seconds = 9999\n", "between 1 and 3600"},
	} {
		t.Run(name, func(t *testing.T) {
			body := tc.body
			if !strings.HasPrefix(body, "[[") {
				body = tc.body + editFile
			} else {
				body = editFile + tc.body
			}
			_, err := Load(writeConfig(t, body))
			if tc.want == "" {
				// "npx -y thing" as one command is allowed here: it fails at
				// start, saying it was not found, which names the problem.
				// mcp_call_timeout_seconds = 0 means the default.
				if err != nil {
					t.Errorf("refused: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Errorf("got %v, want %q", err, tc.want)
			}
		})
	}
}

// `config get` and `config set` deal in one-line values; a table has none.
func TestMCPTablesAreNotKeys(t *testing.T) {
	if slices.Contains(Keys(), "mcp_server") || slices.Contains(Keys(), "ui") {
		t.Error("a table is listed as a key")
	}
	if !slices.Contains(Keys(), "mcp_call_timeout_seconds") {
		t.Error("mcp_call_timeout_seconds is missing from Keys")
	}
	path := writeConfig(t, editFile+mcpTables)
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cfg.Get("mcp_server"); err == nil {
		t.Error("config get mcp_server should be refused")
	}
	for _, key := range []string{"mcp_server", "ui"} {
		if err := Set(path, key, "x"); err == nil {
			t.Errorf("config set %s should be refused", key)
		}
	}
	// A root key set after the tables still lands above them.
	if err := Set(path, "mcp_call_timeout_seconds", "45"); err != nil {
		t.Fatal(err)
	}
	cfg, err = Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.MCPCallTimeoutSeconds != 45 || len(cfg.MCPServers) != 2 {
		t.Errorf("timeout %d, %d servers", cfg.MCPCallTimeoutSeconds, len(cfg.MCPServers))
	}
}

func TestDefaultTOMLDocumentsMCP(t *testing.T) {
	if !strings.Contains(DefaultTOML, mcpMarker) {
		t.Fatal("DefaultTOML lost the line new servers are written below")
	}
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.MCPServers) != 0 {
		t.Error("the default config must start no MCP server")
	}
	if cfg.MCPCallTimeoutSeconds != 30 {
		t.Errorf("mcp_call_timeout_seconds %d", cfg.MCPCallTimeoutSeconds)
	}
}

func setServers(t *testing.T, path string, servers []MCPServer) {
	t.Helper()
	if _, err := UpdateMCPServers(path, func([]MCPServer) ([]MCPServer, error) { return servers, nil }); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateMCPServersOnTheDefaultFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	if err := WriteDefault(path); err != nil {
		t.Fatal(err)
	}
	files := MCPServer{Name: "files", Command: "npx", Args: []string{"-y", `C:\My "Docs"`}, Enabled: true}
	db := MCPServer{Name: "db", Command: "/opt/db-mcp", Env: map[string]string{"TOKEN": "t=1; \"q\"", "A": "é ü"}}
	setServers(t, path, []MCPServer{files})
	body := mustRead(t, path)
	at := strings.Index(body, "[[mcp_server]]\nname = \"files\"")
	if at < 0 || at < strings.Index(body, mcpMarker) || at > strings.Index(body, "# [ui] -- presets") {
		t.Fatalf("the table is not below the marker, above [ui]:\n%s", body[strings.Index(body, mcpMarker)-50:])
	}
	for _, kept := range []string{"GOBBONET - LOCAL AI CHAT", "# [[mcp_server]] -- tools from MCP servers", "# [ui] -- presets", "reply_start_timeout_seconds = 300"} {
		if !strings.Contains(body, kept) {
			t.Errorf("lost %q", kept)
		}
	}

	setServers(t, path, []MCPServer{files, db})
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.MCPServers) != 2 || !cfg.MCPServers[0].Equal(files) || !cfg.MCPServers[1].Equal(db) {
		t.Fatalf("read back: %+v", cfg.MCPServers)
	}

	// Switch one off, then take the other out, then put it back: the file
	// settles, and repeated saves do not grow it.
	files.Enabled = false
	setServers(t, path, []MCPServer{files, db})
	setServers(t, path, []MCPServer{db})
	setServers(t, path, []MCPServer{db, files})
	once := mustRead(t, path)
	setServers(t, path, []MCPServer{db, files})
	if mustRead(t, path) != once {
		t.Error("saving the same servers changed the file")
	}
	setServers(t, path, nil)
	empty := mustRead(t, path)
	if strings.Contains(empty, "\n[[mcp_server]]\n") {
		t.Error("a table survived removing every server")
	}
	if strings.Contains(empty, "\n\n\n") {
		t.Error("removing tables left a growing gap")
	}
	if strings.Count(empty, "\n") > strings.Count(DefaultTOML, "\n")+2 {
		t.Error("the file grew after adding and removing servers")
	}
}

// A hand-written table -- with a sub-table, comments inside and after it,
// and a section following -- is replaced without touching anything else.
func TestUpdateMCPServersOnAHandWrittenFile(t *testing.T) {
	body := editFile + mcpTables + "\n# About the next section.\n[later]\nkey = 1\n"
	// [later] is not a GobboNet table; Load warns about it and goes on.
	path := writeConfig(t, body)
	got, err := UpdateMCPServers(path, func(cur []MCPServer) ([]MCPServer, error) {
		if len(cur) != 2 {
			t.Fatalf("change got %d servers", len(cur))
		}
		cur[1].Enabled = true
		cur[1].Env["NOTES_TOKEN"] = "new"
		return cur, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || !got[1].Enabled || got[1].Env["NOTES_TOKEN"] != "new" {
		t.Fatalf("%+v", got)
	}
	after := mustRead(t, path)
	for _, kept := range []string{"# A comment that has to survive.", "# The token lives in a sub-table", "# About the next section.\n[later]\nkey = 1", "[ui]\nstream_replies = true"} {
		if !strings.Contains(after, kept) {
			t.Errorf("lost %q:\n%s", kept, after)
		}
	}
	if strings.Contains(after, "[mcp_server.env]") || strings.Contains(after, "abc123") {
		t.Errorf("the old sub-table survived:\n%s", after)
	}
}

func TestUpdateMCPServersRefusesAndLeavesTheFile(t *testing.T) {
	path := writeConfig(t, editFile+mcpTables)
	before := mustRead(t, path)
	for name, change := range map[string]func([]MCPServer) ([]MCPServer, error){
		"invalid": func(cur []MCPServer) ([]MCPServer, error) {
			return append(cur, MCPServer{Name: "Bad Name", Command: "x"}), nil
		},
		"duplicate": func(cur []MCPServer) ([]MCPServer, error) {
			return append(cur, cur[0]), nil
		},
		"control character": func(cur []MCPServer) ([]MCPServer, error) {
			cur[0].Args = append(cur[0].Args, "a\nb")
			return cur, nil
		},
		"the change says no": func(cur []MCPServer) ([]MCPServer, error) {
			return nil, ErrMCPConflict
		},
	} {
		_, err := UpdateMCPServers(path, change)
		if err == nil {
			t.Errorf("%s: saved", name)
		}
		if name == "the change says no" && !errors.Is(err, ErrMCPConflict) {
			t.Errorf("the change's own error should come back: %v", err)
		}
		if mustRead(t, path) != before {
			t.Fatalf("%s: the file changed", name)
		}
	}
	// A file that does not load is not touched at all.
	broken := writeConfig(t, "listen_port = \"nope\"\n")
	if _, err := UpdateMCPServers(broken, func(c []MCPServer) ([]MCPServer, error) { return c, nil }); err == nil {
		t.Error("a broken file was changed")
	}
}

// The roadmap's own item: table lists must pass the Config File editor's
// save check -- opened, edited and saved there like any other setting.
func TestConfigFileEditorSavesMCPTables(t *testing.T) {
	path := writeEditFile(t, editFile+mcpTables)
	v, err := ReadForEdit(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(v.Text, "NOTES_TOKEN") {
		t.Fatal("the editor does not show the tables")
	}
	edited := strings.Replace(v.Text, `command = "/opt/notes/bin/mcp"`, `command = "/opt/notes/bin/mcp"`+"\nenabled = true", 1)
	res, err := PrepareEdit(path, edited, v.Version)
	if err != nil {
		t.Fatalf("a valid table list was refused: %v", err)
	}
	if !slices.Contains(res.Changed, "mcp_server") {
		t.Errorf("changed: %v", res.Changed)
	}
	if len(res.New.MCPServers) != 2 || !res.New.MCPServers[1].Enabled {
		t.Errorf("parsed: %+v", res.New.MCPServers)
	}
	if _, err := CommitEdit(path, v.Version, res); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(mustRead(t, path), "# The token lives in a sub-table") {
		t.Error("the editor's save lost a comment")
	}

	// And the same checks Load makes refuse a bad one, saying why.
	v, _ = ReadForEdit(path)
	for bad, want := range map[string]string{
		strings.Replace(v.Text, `name = "files"`, `name = "notes-db"`, 1): "each needs its own name",
		strings.Replace(v.Text, `command = "npx"`, `comand = "npx"`, 1):   "did you mean mcp_server.command",
		strings.Replace(v.Text, `name = "files"`, `name = "Files!"`, 1):   "lowercase letters",
	} {
		if _, err := PrepareEdit(path, bad, v.Version); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("got %v, want %q", err, want)
		}
	}
}

func TestMCPServerTOMLRoundTrips(t *testing.T) {
	m := MCPServer{Name: "x", Command: `C:\Program Files\x\x.exe`, Args: []string{"", "a b", `"q"`, `\`, "é😀"},
		Env: map[string]string{"Z": "1", "A_B": `C:\t`}, Enabled: true}
	path := writeConfig(t, editFile+"\n"+MCPServerTOML(m))
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.MCPServers) != 1 || !cfg.MCPServers[0].Equal(m) {
		t.Errorf("read back %+v", cfg.MCPServers)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
