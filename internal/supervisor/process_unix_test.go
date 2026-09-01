//go:build !windows

package supervisor

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// alive reports whether pid still exists. Signal 0 runs the existence and
// permission checks without delivering anything.
func alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

// waitFor polls until cond holds or the deadline passes. Process teardown is
// asynchronous — the kernel reaps on its own schedule — so a bare assertion
// straight after a kill is flaky in both directions.
func waitFor(cond func() bool, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cond()
}

// startTreeWithHelper launches a shell that spawns a background helper and then
// sleeps, standing in for llama-server and the helpers it forks. It returns the
// leader's process-group id and the helper's pid.
func startTreeWithHelper(t *testing.T) (pgid, helperPID int, leader *exec.Cmd) {
	t.Helper()
	pidFile := filepath.Join(t.TempDir(), "helper.pid")

	// The helper deliberately outlives nothing on its own: it is a plain
	// background sleep, which is what a reparented llama-server helper looks
	// like once its leader is gone.
	script := "sleep 300 & echo $! > " + pidFile + "; sleep 300"
	cmd := exec.Command("/bin/sh", "-c", script)
	configureProcessGroup(cmd)
	if err := cmd.Start(); err != nil {
		t.Fatalf("start leader: %v", err)
	}
	t.Cleanup(func() {
		_ = terminateGroup(processGroupID(cmd), true)
		_ = cmd.Wait()
	})

	pgid = processGroupID(cmd)
	if pgid <= 0 {
		t.Fatal("processGroupID returned no group for a started process")
	}

	// Wait for the helper to record its pid.
	var pid int
	ok := waitFor(func() bool {
		b, err := os.ReadFile(pidFile)
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil && pid > 0
	}, 5*time.Second)
	if !ok {
		t.Fatal("helper never reported its pid")
	}
	if !alive(pid) {
		t.Fatalf("helper %d was not running", pid)
	}
	return pgid, pid, cmd
}

// TestTerminateGroupKillsHelpers is the orphan bug in miniature.
//
// Killing only the leader leaves llama-server's helpers running, still holding
// VRAM and the upstream port. The replacement server then fails to bind, exits
// in milliseconds, and /swap-status sits at "starting" — which reads as a slow
// model rather than a leaked process. The whole point of putting the child in
// its own group is that one signal reaches all of it.
func TestTerminateGroupKillsHelpers(t *testing.T) {
	pgid, helperPID, leader := startTreeWithHelper(t)

	if err := terminateGroup(pgid, true); err != nil {
		t.Fatalf("terminateGroup: %v", err)
	}
	_ = leader.Wait()

	if !waitFor(func() bool { return !alive(helperPID) }, 5*time.Second) {
		t.Errorf("helper %d survived the group kill -- this is the orphan leak", helperPID)
	}
	if !waitFor(func() bool { return !groupAlive(pgid) }, 5*time.Second) {
		t.Error("groupAlive still reports members after the group was killed")
	}
}

// TestKillingOnlyTheLeaderLeavesHelpers documents why the group is necessary
// rather than assuming it. If this ever stops holding, the group handling is
// redundant and the reasoning in process_unix.go is wrong.
func TestKillingOnlyTheLeaderLeavesHelpers(t *testing.T) {
	_, helperPID, leader := startTreeWithHelper(t)

	if err := leader.Process.Kill(); err != nil {
		t.Fatalf("kill leader: %v", err)
	}
	_ = leader.Wait()

	// Give the helper every chance to notice its parent died. It will not.
	time.Sleep(300 * time.Millisecond)
	if !alive(helperPID) {
		t.Skip("helper did not outlive its leader on this system; the group kill is still correct")
	}

	// The helper is orphaned. The group still reaches it, which is the fix.
	pgid, err := syscall.Getpgid(helperPID)
	if err != nil {
		t.Fatalf("getpgid on the orphan: %v", err)
	}
	if err := terminateGroup(pgid, true); err != nil {
		t.Fatalf("terminateGroup on the orphan's group: %v", err)
	}
	if !waitFor(func() bool { return !alive(helperPID) }, 5*time.Second) {
		t.Errorf("orphaned helper %d could not be reached through its group", helperPID)
	}
}

// TestGroupIDSurvivesReaping pins the reason pgid is stored separately from
// cmd. Once the reaper has Wait()ed the leader its pid is gone from the table
// and Getpgid fails with ESRCH — but the helpers are still running. Deriving
// the group late is exactly the case where it cannot be derived.
func TestGroupIDSurvivesReaping(t *testing.T) {
	pgid, helperPID, leader := startTreeWithHelper(t)

	if err := leader.Process.Kill(); err != nil {
		t.Fatalf("kill leader: %v", err)
	}
	_ = leader.Wait() // reaped: the leader's pid is now unusable

	if _, err := syscall.Getpgid(leader.Process.Pid); err == nil {
		t.Skip("leader pid still resolvable after reaping on this system")
	}

	// The captured group id still works, which is the whole argument for
	// keeping it.
	if err := terminateGroup(pgid, true); err != nil {
		t.Fatalf("terminateGroup with the captured pgid: %v", err)
	}
	if !waitFor(func() bool { return !alive(helperPID) }, 5*time.Second) {
		t.Errorf("captured pgid %d did not reach helper %d after reaping", pgid, helperPID)
	}
}

// TestTerminateGroupOnEmptyGroupIsNotAnError keeps a second stop, or a stop
// after the tree already exited, from being reported as a failure. That is the
// goal state, not a fault.
func TestTerminateGroupOnEmptyGroupIsNotAnError(t *testing.T) {
	pgid, _, leader := startTreeWithHelper(t)
	if err := terminateGroup(pgid, true); err != nil {
		t.Fatalf("first terminateGroup: %v", err)
	}
	_ = leader.Wait()
	waitFor(func() bool { return !groupAlive(pgid) }, 5*time.Second)

	if err := terminateGroup(pgid, true); err != nil {
		t.Errorf("terminateGroup on an already-empty group returned %v, want nil", err)
	}
}

// TestTerminateGroupIgnoresZero guards the uninitialised case. A zero pgid must
// never reach kill(2), where negating it would signal the caller's own group --
// gobbonet killing itself and every process sharing its terminal.
func TestTerminateGroupIgnoresZero(t *testing.T) {
	if err := terminateGroup(0, true); err != nil {
		t.Errorf("terminateGroup(0) = %v, want nil", err)
	}
	if groupAlive(0) {
		t.Error("groupAlive(0) reported members")
	}
	if got := processGroupID(nil); got != 0 {
		t.Errorf("processGroupID(nil) = %d, want 0", got)
	}
}

// TestSuperviseTreeIsSafeOnUnix covers the no-op half of the Windows job-object
// backstop. It must never fail a launch on a platform that has no equivalent.
func TestSuperviseTreeIsSafeOnUnix(t *testing.T) {
	if err := superviseTree(nil); err != nil {
		t.Errorf("superviseTree(nil) = %v, want nil", err)
	}
	cmd := exec.Command("/bin/sh", "-c", "sleep 1")
	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()

	if err := superviseTree(cmd); err != nil {
		t.Errorf("superviseTree(running cmd) = %v, want nil", err)
	}
}
