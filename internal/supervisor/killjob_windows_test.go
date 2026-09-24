//go:build windows

package supervisor

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestJobTreeHelper(t *testing.T) {
	mode := os.Getenv("GOBBONET_JOB_HELPER")
	if mode == "" {
		return
	}
	if mode == "leaf" {
		for {
			time.Sleep(time.Second)
		}
	}
	gate := os.Getenv("GOBBONET_JOB_GATE")
	for {
		if _, err := os.Stat(gate); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	exe, _ := os.Executable()
	child := exec.Command(exe, "-test.run=^TestJobTreeHelper$")
	child.Env = []string{"GOBBONET_JOB_HELPER=leaf", "SystemRoot=" + os.Getenv("SystemRoot")}
	if err := child.Start(); err != nil {
		os.Exit(2)
	}
	os.WriteFile(gate+".child", []byte(fmt.Sprint(child.Process.Pid)), 0600)
	os.Exit(0)
}

// Native Windows regression: job membership survives the root's exit.
func TestJobTreeRetainsDescendantsAfterLeaderExit(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	gate := filepath.Join(t.TempDir(), "start")
	cmd := exec.Command(exe, "-test.run=^TestJobTreeHelper$")
	cmd.Env = append(os.Environ(), "GOBBONET_JOB_HELPER=root", "GOBBONET_JOB_GATE="+gate)
	configureProcessGroup(cmd)
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	pid := cmd.Process.Pid
	defer func() { terminateGroup(pid, true); cmd.Process.Kill(); releaseTree(pid) }()
	if err = superviseTree(cmd); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(gate, []byte("go"), 0600); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("helper root did not exit")
	}
	if _, err = os.Stat(gate + ".child"); err != nil {
		t.Fatal(err)
	}
	if !groupAlive(pid) {
		t.Fatal("root exited but its owned child was forgotten")
	}
	if err = terminateGroup(pid, true); err != nil {
		t.Fatal(err)
	}
	if !waitGroupGone(pid, 5*time.Second) {
		t.Fatal("job descendants survived cleanup")
	}
}
