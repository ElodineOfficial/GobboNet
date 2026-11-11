//go:build !windows

package supervisor

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// A Child (1.8.0, #16: MCP servers) is stopped as the engines are: the whole
// group, so a helper the program started does not outlive it.
func TestChildStopEndsItsHelpers(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "helper.pid")
	cmd := exec.Command("/bin/sh", "-c", "sleep 300 & echo $! > "+pidFile+"; sleep 300")
	c, err := StartChild(cmd, "[test]", "a test program")
	if err != nil {
		t.Fatal(err)
	}
	var helper int
	if !waitFor(func() bool {
		b, err := os.ReadFile(pidFile)
		if err != nil {
			return false
		}
		helper, err = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil && helper > 0
	}, 5*time.Second) {
		t.Fatal("helper never reported its pid")
	}
	leader := c.PID()
	if err := c.Stop(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.Exited():
	default:
		t.Error("Exited is still open after Stop")
	}
	if !waitFor(func() bool { return !alive(leader) && !alive(helper) }, 5*time.Second) {
		t.Errorf("leader alive=%v helper alive=%v after Stop", alive(leader), alive(helper))
	}
	// Twice is safe, and says the same.
	if err := c.Stop(); err != nil {
		t.Errorf("second Stop: %v", err)
	}
}

// A program that ends by itself closes Exited and reports how it ended; Stop
// afterwards still sweeps the group.
func TestChildExitIsSeen(t *testing.T) {
	c, err := StartChild(exec.Command("/bin/sh", "-c", "exit 4"), "[test]", "a test program")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-c.Exited():
	case <-time.After(5 * time.Second):
		t.Fatal("Exited never closed")
	}
	if err := c.ExitErr(); err == nil || !strings.Contains(err.Error(), "exit status 4") {
		t.Errorf("ExitErr: %v", err)
	}
	if err := c.Stop(); err != nil {
		t.Errorf("Stop after exit: %v", err)
	}
}

func TestStartChildReportsAMissingProgram(t *testing.T) {
	if _, err := StartChild(exec.Command(filepath.Join(t.TempDir(), "nope")), "[test]", "a missing program"); err == nil ||
		!strings.Contains(err.Error(), "could not start a missing program") {
		t.Errorf("got %v", err)
	}
}
