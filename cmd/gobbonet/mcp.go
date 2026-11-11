package main

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

// MCP servers (1.8.0, #16) in the startup banner and in doctor.

// reportMCPStartup is one line for serve: which servers are switched on.
// Nothing is started here -- a server starts the first time a character's
// tool list or call needs it -- so the line says that rather than "[OK]".
func reportMCPStartup(w io.Writer, cfg config.Config) {
	var on []string
	for _, m := range cfg.MCPServers {
		if m.Enabled {
			on = append(on, m.Name)
		}
	}
	if len(on) == 0 {
		return
	}
	fmt.Fprintf(w, " [OK] MCP servers switched on: %s. Each starts when a character first needs its tools.\n", strings.Join(on, ", "))
}

// reportMCP is doctor's MCP section: every server, whether its program can
// be found, and where its log is.
func reportMCP(w io.Writer, cfg config.Config) {
	fmt.Fprintln(w, "MCP SERVERS (tools for characters)")
	if len(cfg.MCPServers) == 0 {
		fmt.Fprintln(w, "  none set up. Add one in CONFIG > Advanced > MCP Servers, on this PC.")
		return
	}
	logDir := filepath.Dir(cfg.LogFile())
	for _, m := range cfg.MCPServers {
		state := "off"
		if m.Enabled {
			state = "on"
		}
		fmt.Fprintf(w, "  %-12s %s: %s\n", m.Name, state, mcpCommandLine(m))
		if where, err := findCommand(cfg, m.Command); err != nil {
			fmt.Fprintf(w, "  %-12s program: NOT FOUND -- %v\n", "", err)
		} else {
			fmt.Fprintf(w, "  %-12s program: %s\n", "", where)
		}
		if len(m.Env) > 0 {
			var names []string
			for k := range m.Env {
				names = append(names, k)
			}
			sort.Strings(names)
			fmt.Fprintf(w, "  %-12s env:     %s (values not shown)\n", "", strings.Join(names, ", "))
		}
		log := filepath.Join(logDir, "mcp-"+m.Name+".log")
		if _, err := os.Stat(log); err == nil {
			fmt.Fprintf(w, "  %-12s log:     %s\n", "", log)
		}
	}
	fmt.Fprintf(w, "  a call may take: %d seconds (mcp_call_timeout_seconds)\n", cfg.MCPCallTimeoutSeconds)
}

func mcpCommandLine(m config.MCPServer) string {
	parts := []string{m.Command}
	for _, a := range m.Args {
		if a == "" || strings.ContainsAny(a, " \t\"") {
			a = fmt.Sprintf("%q", a)
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

// findCommand finds a server's program as internal/mcp will: an absolute
// path as it is, a relative one from config.toml's folder, a bare name on
// PATH.
func findCommand(cfg config.Config, command string) (string, error) {
	if !filepath.IsAbs(command) && strings.ContainsAny(command, `/\`) && cfg.Path != "" {
		command = filepath.Join(filepath.Dir(cfg.Path), command)
	}
	if filepath.IsAbs(command) {
		st, err := os.Stat(command)
		if err != nil {
			return "", fmt.Errorf("there is no program at %s", command)
		}
		if st.IsDir() {
			return "", fmt.Errorf("%s is a folder", command)
		}
		return command, nil
	}
	p, err := exec.LookPath(command)
	if err != nil {
		return "", fmt.Errorf("%q is not on PATH", command)
	}
	return p, nil
}
