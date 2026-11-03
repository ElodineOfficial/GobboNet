package procjob

import (
	"os/exec"
	"runtime"
	"testing"
)

// The portable contract: both calls are safe on every platform, and an
// unstarted command is reported rather than dereferenced. The job behaviour
// itself needs Windows; procjob_windows_test.go covers it there.
func TestTieToLifetimeRejectsUnstartedOnWindowsOnly(t *testing.T) {
	err := TieToLifetime(exec.Command("true"))
	if runtime.GOOS == "windows" && err == nil {
		t.Error("an unstarted command should be reported on Windows")
	}
	if runtime.GOOS != "windows" && err != nil {
		t.Errorf("no-op expected off Windows, got %v", err)
	}
}

func TestStartDetachedStarts(t *testing.T) {
	name, args := "true", []string{}
	if runtime.GOOS == "windows" {
		name, args = "cmd.exe", []string{"/d", "/c", "exit", "0"}
	}
	cmd := exec.Command(name, args...)
	if err := StartDetached(cmd); err != nil {
		t.Fatalf("StartDetached: %v", err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("detached child failed: %v", err)
	}
}
