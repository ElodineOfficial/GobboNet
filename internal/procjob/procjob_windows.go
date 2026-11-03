//go:build windows

package procjob

import (
	"fmt"
	"os/exec"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Handles are kept for the life of the process on purpose: closing one is what
// ends the tree, so a handle must never be closed early or collected.
var held struct {
	sync.Mutex
	jobs []windows.Handle
}

// TieToLifetime puts cmd's process, and every process it starts afterwards,
// into a job that the kernel ends when this process exits. cmd must already
// be started.
//
// Like the engine's job (internal/supervisor/killjob_windows.go), the child is
// assigned just after it starts, because os/exec does not expose the thread
// handle CREATE_SUSPENDED would need. cmd.exe spends its first moments reading
// launch.bat, long before it starts anything, so the window is negligible.
//
// A failure is returned for the caller to log. It is a backstop for abnormal
// exits, never a reason to refuse to run setup.
func TieToLifetime(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return fmt.Errorf("procjob: process not started")
	}
	h, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return fmt.Errorf("procjob: create job: %w", err)
	}
	info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
		BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
			LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | windows.JOB_OBJECT_LIMIT_BREAKAWAY_OK,
		},
	}
	if _, err := windows.SetInformationJobObject(h, windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&info)), uint32(unsafe.Sizeof(info))); err != nil {
		windows.CloseHandle(h)
		return fmt.Errorf("procjob: set limits: %w", err)
	}
	p, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(cmd.Process.Pid))
	if err != nil {
		windows.CloseHandle(h)
		return fmt.Errorf("procjob: open process: %w", err)
	}
	defer windows.CloseHandle(p)
	if err := windows.AssignProcessToJobObject(h, p); err != nil {
		windows.CloseHandle(h)
		return fmt.Errorf("procjob: assign: %w", err)
	}
	held.Lock()
	held.jobs = append(held.jobs, h)
	held.Unlock()
	return nil
}

// StartDetached starts cmd outside any job this process is in, so it outlives
// GobboNet. If the job this process belongs to does not allow breakaway (one
// GobboNet did not create), Windows refuses the flag; cmd is then started
// normally, which is exactly what happened before 1.7.9.
func StartDetached(cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.CreationFlags |= windows.CREATE_BREAKAWAY_FROM_JOB
	if err := cmd.Start(); err == nil {
		return nil
	}
	retry := exec.Command(cmd.Path, cmd.Args[1:]...)
	retry.Dir, retry.Env = cmd.Dir, cmd.Env
	return retry.Start()
}
