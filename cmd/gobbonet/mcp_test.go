package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

func TestDoctorReportsMCPServers(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Default()
	cfg.Path = filepath.Join(dir, "config.toml")
	cfg.DataDir = dir
	cfg.MCPCallTimeoutSeconds = 30
	var b strings.Builder
	reportMCP(&b, cfg)
	if !strings.Contains(b.String(), "none set up") {
		t.Errorf("no servers:\n%s", b.String())
	}

	exe, _ := os.Executable()
	cfg.MCPServers = []config.MCPServer{
		{Name: "here", Command: exe, Args: []string{"a b"}, Env: map[string]string{"TOKEN": "secret-value"}, Enabled: true},
		{Name: "gone", Command: "gobbonet-no-such-program"},
	}
	os.WriteFile(filepath.Join(dir, "mcp-here.log"), []byte("x"), 0o600)
	b.Reset()
	reportMCP(&b, cfg)
	out := b.String()
	for _, want := range []string{"here         on: " + exe + ` "a b"`, "program: " + exe, "env:     TOKEN (values not shown)",
		"mcp-here.log", "gone         off:", "NOT FOUND", "30 seconds"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "secret-value") {
		t.Error("doctor printed an env value")
	}

	b.Reset()
	reportMCPStartup(&b, cfg)
	if !strings.Contains(b.String(), "MCP servers switched on: here.") {
		t.Errorf("startup: %q", b.String())
	}
	cfg.MCPServers[0].Enabled = false
	b.Reset()
	reportMCPStartup(&b, cfg)
	if b.Len() != 0 {
		t.Errorf("nothing switched on should print nothing: %q", b.String())
	}
}
