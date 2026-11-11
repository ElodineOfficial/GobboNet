package mcp

import (
	"os"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/mcp/mcptest"
)

// The fake MCP server the tests start is the test binary itself; see
// internal/mcp/mcptest.
func TestMain(m *testing.M) {
	mcptest.Main()
	os.Exit(m.Run())
}

func recorded(t *testing.T, path string) []string {
	t.Helper()
	return mcptest.Recorded(path)
}
