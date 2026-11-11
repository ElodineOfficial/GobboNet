package config

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
)

// MCP servers (1.8.0, #16): programs that offer tools a character can call.
// GobboNet starts each one on this PC and speaks MCP to it over stdin and
// stdout (internal/mcp). They are [[mcp_server]] tables in config.toml, written
// by hand, by the Config File editor, or by CONFIG > Advanced > MCP Servers
// through SetMCPServers below.

// MCPServer is one [[mcp_server]] table.
type MCPServer struct {
	Name    string            `toml:"name" json:"name"`
	Command string            `toml:"command" json:"command"`
	Args    []string          `toml:"args" json:"args"`
	Env     map[string]string `toml:"env" json:"env"`
	Enabled bool              `toml:"enabled" json:"enabled"`
}

// MCP limits. The counts are far past any real setup; they exist so a file
// or a request cannot make the page or the process table enormous.
const (
	DefaultMCPCallTimeoutSeconds = 30
	MaxMCPServers                = 32
	maxMCPArgs                   = 64
	maxMCPEnv                    = 64
	maxMCPString                 = 4096
)

var (
	mcpNameRE   = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)
	mcpEnvKeyRE = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)
)

// mcpServerKeys are the keys an [[mcp_server]] table may hold, for the typo
// check in Load (see mcpTypo).
var mcpServerKeys = []string{"name", "command", "args", "env", "enabled"}

// mcpTypo is nearestKey for a key inside an [[mcp_server]] table:
// "mcp_server.comand" is "command" misspelt. "" when key is not in such a
// table or resembles none of its keys.
//
// A top-level setting written below an [[mcp_server]] table is read as part of
// that table, so it arrives here too ("mcp_server.listen_port"); the answer
// then says where it belongs.
func mcpTypo(key string) string {
	rest, ok := strings.CutPrefix(key, "mcp_server.")
	if !ok || strings.Contains(rest, ".") || len(rest) <= 2 {
		return ""
	}
	if slices.Contains(Keys(), rest) {
		return rest + ", above the first [[mcp_server]] table: below it, a setting belongs to the table"
	}
	for _, k := range mcpServerKeys {
		if editDistance(rest, k) <= 2 && editDistance(rest, k) <= len(k)/3+1 {
			return "mcp_server." + k
		}
	}
	return ""
}

func badChars(s string) bool {
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

// Validate checks one server's table. The error names the server.
func (m MCPServer) Validate() error {
	label := fmt.Sprintf("mcp_server %q", m.Name)
	if m.Name == "" {
		return errors.New(`every [[mcp_server]] needs a name, like name = "files"`)
	}
	if !mcpNameRE.MatchString(m.Name) {
		return fmt.Errorf("%s: a name is 1 to 32 lowercase letters, digits, - and _, starting with a letter or digit", label)
	}
	if strings.TrimSpace(m.Command) == "" {
		return fmt.Errorf("%s: command is required: the program to start, by name or full path", label)
	}
	if m.Command != strings.TrimSpace(m.Command) {
		return fmt.Errorf("%s: command has spaces at the start or end; put arguments in args, one per item", label)
	}
	if len(m.Command) > maxMCPString || badChars(m.Command) {
		return fmt.Errorf("%s: command is too long or holds control characters", label)
	}
	if len(m.Args) > maxMCPArgs {
		return fmt.Errorf("%s: at most %d args", label, maxMCPArgs)
	}
	for _, a := range m.Args {
		if len(a) > maxMCPString || badChars(a) {
			return fmt.Errorf("%s: an argument is too long or holds control characters", label)
		}
	}
	if len(m.Env) > maxMCPEnv {
		return fmt.Errorf("%s: at most %d env entries", label, maxMCPEnv)
	}
	for k, v := range m.Env {
		if !mcpEnvKeyRE.MatchString(k) {
			return fmt.Errorf("%s: env name %q must be letters, digits and _, not starting with a digit", label, k)
		}
		if len(v) > maxMCPString || badChars(v) {
			return fmt.Errorf("%s: env %s is too long or holds control characters", label, k)
		}
	}
	return nil
}

// Equal reports whether two tables describe the same server, so a restart is
// not needed. A nil and an empty list (or table) are the same.
func (m MCPServer) Equal(o MCPServer) bool {
	if m.Name != o.Name || m.Command != o.Command || m.Enabled != o.Enabled || len(m.Args) != len(o.Args) || len(m.Env) != len(o.Env) {
		return false
	}
	for i := range m.Args {
		if m.Args[i] != o.Args[i] {
			return false
		}
	}
	for k, v := range m.Env {
		if w, ok := o.Env[k]; !ok || w != v {
			return false
		}
	}
	return true
}

func (c *Config) normaliseMCP() error {
	if c.MCPCallTimeoutSeconds == 0 {
		c.MCPCallTimeoutSeconds = DefaultMCPCallTimeoutSeconds
	}
	if c.MCPCallTimeoutSeconds < 1 || c.MCPCallTimeoutSeconds > 3600 {
		return fmt.Errorf("mcp_call_timeout_seconds must be between 1 and 3600, not %d", c.MCPCallTimeoutSeconds)
	}
	if len(c.MCPServers) > MaxMCPServers {
		return fmt.Errorf("at most %d [[mcp_server]] tables", MaxMCPServers)
	}
	seen := map[string]bool{}
	for _, m := range c.MCPServers {
		if err := m.Validate(); err != nil {
			return err
		}
		if seen[m.Name] {
			return fmt.Errorf("two [[mcp_server]] tables are named %q; each needs its own name", m.Name)
		}
		seen[m.Name] = true
	}
	return nil
}

// MCPCallTimeout is mcp_call_timeout_seconds as a duration.
func (c Config) MCPCallTimeout() time.Duration {
	if c.MCPCallTimeoutSeconds <= 0 {
		return DefaultMCPCallTimeoutSeconds * time.Second
	}
	return time.Duration(c.MCPCallTimeoutSeconds) * time.Second
}

// MCPServer returns the table named name.
func (c Config) MCPServer(name string) (MCPServer, bool) {
	for _, m := range c.MCPServers {
		if m.Name == name {
			return m, true
		}
	}
	return MCPServer{}, false
}

// isTableField reports whether a Config field is a TOML table or a list of
// tables ([ui], [[mcp_server]]): something `config get` and `config set` have
// no one-line form for.
func isTableField(t reflect.Type) bool {
	return t.Kind() == reflect.Map || (t.Kind() == reflect.Slice && t.Elem().Kind() == reflect.Struct)
}

// ---------------------------------------------------------------------------
// Writing [[mcp_server]] tables
// ---------------------------------------------------------------------------

// tomlString writes s as a TOML basic string. strconv.Quote is not a TOML
// writer: it emits \x07 and \U escapes TOML reads differently or not at all.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		default:
			if r < 0x20 || r == 0x7f {
				fmt.Fprintf(&b, `\u%04X`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// MCPServerTOML is one server as the table SetMCPServers writes.
func MCPServerTOML(m MCPServer) string {
	var b strings.Builder
	b.WriteString("[[mcp_server]]\n")
	b.WriteString("name = " + tomlString(m.Name) + "\n")
	b.WriteString("command = " + tomlString(m.Command) + "\n")
	args := make([]string, len(m.Args))
	for i, a := range m.Args {
		args[i] = tomlString(a)
	}
	b.WriteString("args = [" + strings.Join(args, ", ") + "]\n")
	if len(m.Env) > 0 {
		keys := make([]string, 0, len(m.Env))
		for k := range m.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = k + " = " + tomlString(m.Env[k])
		}
		b.WriteString("env = { " + strings.Join(parts, ", ") + " }\n")
	}
	fmt.Fprintf(&b, "enabled = %t\n", m.Enabled)
	return b.String()
}

var (
	anyHeaderRE = regexp.MustCompile(`^\s*\[`)
	// [[mcp_server]], and the sub-tables a hand-written one may carry:
	// [mcp_server.env].
	mcpHeaderRE = regexp.MustCompile(`^\s*\[\[\s*mcp_server\s*\]\]`)
	mcpSubRE    = regexp.MustCompile(`^\s*\[\s*mcp_server\s*\.`)
)

// mcpMarker is the line in DefaultTOML below which new [[mcp_server]] tables
// are written, so they sit with the section that explains them.
const mcpMarker = "# MCP servers added from CONFIG are written below this line."

// replaceMCPTables returns raw with every [[mcp_server]] table replaced by
// tables. Everything else -- every comment, every other section -- is kept as
// it was, as `config set` keeps it: the comments are the documentation.
//
// A table runs from its header to its last key line before the next header
// that is not one of its own sub-tables. Comment and blank lines after that
// last key are left where they are, because they introduce what follows.
func replaceMCPTables(raw []byte, servers []MCPServer) []byte {
	lines := strings.Split(strings.ReplaceAll(string(raw), "\r\n", "\n"), "\n")
	if n := len(lines); n > 0 && lines[n-1] == "" {
		lines = lines[:n-1]
	}
	var out []string
	insertAt := -1
	for i := 0; i < len(lines); {
		if !mcpHeaderRE.MatchString(lines[i]) {
			out = append(out, lines[i])
			i++
			continue
		}
		end := i + 1 // one past the table's last line
		for j := i + 1; j < len(lines); j++ {
			l := lines[j]
			if anyHeaderRE.MatchString(l) && !mcpHeaderRE.MatchString(l) && !mcpSubRE.MatchString(l) {
				break
			}
			if mcpHeaderRE.MatchString(l) {
				// The next table starts here; this one ends at its last key.
				break
			}
			if t := strings.TrimSpace(l); t != "" && !strings.HasPrefix(t, "#") {
				end = j + 1
			}
		}
		if insertAt < 0 {
			insertAt = len(out)
		}
		i = end
		// Drop the blank line that separated the table from what follows, so
		// taking tables out does not leave a gap that grows with every save.
		for i < len(lines) && strings.TrimSpace(lines[i]) == "" &&
			(len(out) == 0 || strings.TrimSpace(out[len(out)-1]) == "") {
			i++
		}
	}
	if len(servers) == 0 {
		return []byte(strings.Join(out, "\n") + "\n")
	}
	if insertAt < 0 {
		// No tables yet: below the marker if the file has it, else at the end.
		insertAt = len(out)
		for i, l := range out {
			if strings.TrimSpace(l) == mcpMarker {
				insertAt = i + 1
				break
			}
		}
	}
	var block []string
	if insertAt > 0 && strings.TrimSpace(out[insertAt-1]) != "" {
		block = append(block, "")
	}
	for k, m := range servers {
		if k > 0 {
			block = append(block, "")
		}
		block = append(block, strings.Split(strings.TrimRight(MCPServerTOML(m), "\n"), "\n")...)
	}
	if insertAt < len(out) && strings.TrimSpace(out[insertAt]) != "" {
		block = append(block, "")
	}
	out = append(out[:insertAt], append(block, out[insertAt:]...)...)
	return []byte(strings.Join(out, "\n") + "\n")
}

// ErrMCPConflict means the servers in the file are not the ones the change
// was made against: another save got there first.
var ErrMCPConflict = errors.New("the MCP servers in config.toml changed since this list was loaded")

// UpdateMCPServers rewrites the [[mcp_server]] tables in the file at path.
// change gets the servers the file has now and returns the ones it should
// have. The result is parsed exactly as Load parses it before anything is
// written, so a save here can never leave a file the server will not start
// with, and it must read back as exactly the servers change returned.
func UpdateMCPServers(path string, change func([]MCPServer) ([]MCPServer, error)) ([]MCPServer, error) {
	setMu.Lock()
	defer setMu.Unlock()
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cur, _, err := parseText(path, raw)
	if err != nil {
		return nil, fmt.Errorf("config.toml does not load as it is, so it was not changed: %w", err)
	}
	want, err := change(append([]MCPServer(nil), cur.MCPServers...))
	if err != nil {
		return nil, err
	}
	out := replaceMCPTables(raw, want)
	got, _, err := parseText(path, out)
	if err != nil {
		return nil, err
	}
	if len(got.MCPServers) != len(want) {
		return nil, fmt.Errorf("the MCP servers did not read back as written (%d of %d); config.toml was not changed", len(got.MCPServers), len(want))
	}
	for i := range want {
		if !got.MCPServers[i].Equal(want[i]) {
			return nil, fmt.Errorf("mcp_server %q did not read back as written; config.toml was not changed", want[i].Name)
		}
	}
	if bytes.Equal(out, raw) {
		return got.MCPServers, nil
	}
	if err := atomicfile.Write(path, out, 0o600); err != nil {
		return nil, err
	}
	return got.MCPServers, nil
}
