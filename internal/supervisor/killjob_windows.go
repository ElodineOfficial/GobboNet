//go:build windows

package supervisor

import (
	"fmt"
	"golang.org/x/sys/windows"
	"os/exec"
	"sync"
	"unsafe"
)

// One job per engine generation. Unlike a root PID, a job still identifies
// owned descendants after their parent exits. Closing GobboNet also closes
// these non-inherited handles, so Windows terminates every remaining member.
var engineJobs = struct {
	sync.Mutex
	handles map[int]windows.Handle
}{handles: make(map[int]windows.Handle)}

func superviseTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return err
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE},
	}
	if _, err = windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(h)
		return err
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(h)
		return err
	}
	defer windows.CloseHandle(p)
	if err = windows.AssignProcessToJobObject(h, p); err != nil {
		windows.CloseHandle(h)
		return err
	}
	engineJobs.Lock()
	engineJobs.handles[cmd.Process.Pid] = h
	engineJobs.Unlock()
	return nil
}

func jobAlive(pid int) (alive, owned bool) {
	engineJobs.Lock()
	defer engineJobs.Unlock()
	h, ok := engineJobs.handles[pid]
	if !ok {
		return false, false
	}
	// JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four LARGE_INTEGER times,
	// four DWORD counters including ActiveProcesses and terminated count.
	var info struct {
		User, Kernel, PeriodUser, PeriodKernel int64
		PageFaults, Total, Active, Terminated  uint32
	}
	err := windows.QueryInformationJobObject(h, windows.JobObjectBasicAccountingInformation, uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info)), nil)
	return err != nil || info.Active != 0, true
}

func terminateJob(pid int) (bool, error) {
	engineJobs.Lock()
	defer engineJobs.Unlock()
	h, ok := engineJobs.handles[pid]
	if !ok {
		return false, nil
	}
	if err := windows.TerminateJobObject(h, 1); err != nil {
		return true, fmt.Errorf("terminate engine job: %w", err)
	}
	return true, nil
}

// Called only after membership is confirmed empty. Retain failed jobs so
// future cleanup never loses ownership of a child still holding memory.
func releaseTree(pid int) {
	engineJobs.Lock()
	defer engineJobs.Unlock()
	if h, ok := engineJobs.handles[pid]; ok {
		windows.CloseHandle(h)
		delete(engineJobs.handles, pid)
	}
}
