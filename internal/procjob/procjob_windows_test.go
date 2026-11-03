//go:build windows

package procjob

import (
	"os/exec"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// A child started by a tied process is in the job, and terminating the job
// (what the kernel does when this process dies) ends it.
func TestChildrenJoinTheJobAndDieWithIt(t *testing.T) {
	cmd := exec.Command("cmd.exe", "/d", "/c", "ping -n 30 127.0.0.1 >nul")
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	if err := TieToLifetime(cmd); err != nil {
		t.Fatal(err)
	}
	held.Lock()
	h := held.jobs[len(held.jobs)-1]
	held.Unlock()

	var acct struct {
		User, Kernel, PeriodUser, PeriodKernel int64
		PageFaults, Total, Active, Terminated  uint32
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		windows.QueryInformationJobObject(h, windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&acct)), uint32(unsafe.Sizeof(acct)), nil)
		if acct.Active >= 2 { // cmd.exe + ping.exe
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if acct.Active < 2 {
		t.Fatalf("ping.exe never joined the job (active=%d)", acct.Active)
	}
	if err := windows.TerminateJobObject(h, 1); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("tree survived the job ending")
	}
}
