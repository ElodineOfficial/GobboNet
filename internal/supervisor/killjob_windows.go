//go:build windows

package supervisor

import (
	"fmt"
	"os/exec"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

// The orphan problem this file solves
//
// Everything else in this package cleans up llama-server by running Go code:
// Shutdown on Ctrl+C, stop() on a swap, the reaper on an unexpected exit. All
// of it depends on gobbonet getting a chance to run.
//
// It does not always get one. `taskkill /F`, Task Manager's "End task", a
// panic, an out-of-memory kill, or closing the console window a shortcut opened
// all end this process with no notice and no handler. llama-server then
// survives its parent, holding several gigabytes of VRAM and the upstream port.
// The next launch fails to bind, exits in milliseconds, and /swap-status sits at
// "starting" — which reads as a slow model rather than a leaked process. This is
// the "orphaned Windows background processes" report.
//
// A watchdog that polls for a dead parent cannot close this: the watchdog is
// itself a process that can be killed, and it can only notice the orphan after
// the fact. Windows already has the right primitive, so this uses it.
//
// A job object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE terminates every process
// in the job when the last handle to it closes. The kernel closes this process's
// handles when it dies, whatever killed it — so the guarantee holds for exactly
// the cases the Go-side cleanup cannot reach. No polling, no second process,
// nothing to keep alive.
//
// The Unix build has no equivalent and does not pretend to: see the note in
// process_unix.go.

// killJob is the process-wide job object. One job holds every llama-server this
// process starts, across swaps — a swap's old process is stopped explicitly by
// stop(), and the job is the backstop for the ones that never get that far.
//
// Created once, lazily, and deliberately never closed: closing the handle is
// what triggers the kill, so it must stay open for the life of the process and
// be released by the kernel at exit.
var (
	killJobOnce sync.Once
	killJob     windows.Handle
	killJobErr  error
)

func ensureKillJob() (windows.Handle, error) {
	killJobOnce.Do(func() {
		// Anonymous: a named job could be opened, and inherited, by anything
		// else on the machine. Nothing outside this process needs to find it.
		h, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			killJobErr = fmt.Errorf("create job object: %w", err)
			return
		}
		info := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{
			BasicLimitInformation: windows.JOBOBJECT_BASIC_LIMIT_INFORMATION{
				LimitFlags: windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
			},
		}
		if _, err := windows.SetInformationJobObject(
			h,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info)),
		); err != nil {
			windows.CloseHandle(h)
			killJobErr = fmt.Errorf("set kill-on-close on job object: %w", err)
			return
		}
		killJob = h
	})
	return killJob, killJobErr
}

// superviseTree ties cmd's process tree to the lifetime of this process.
//
// Returns an error only for diagnosis; the caller logs it and carries on,
// because a job object that could not be created is a lost backstop rather than
// a reason to refuse to run a model. Every explicit cleanup path still works.
//
// Job membership is inherited, so llama-server's own helpers join the job when
// it spawns them and are covered by the same guarantee.
//
// There is a small race here: the child is assigned after it has already
// started, so a helper spawned in that window would escape. It is opened to a
// process that spends its first seconds reading a multi-gigabyte model off
// disk before it spawns anything, which makes the window sub-millisecond
// against a wait of seconds. Closing it properly needs CREATE_SUSPENDED and a
// thread handle that os/exec does not expose.
func superviseTree(cmd *exec.Cmd) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	job, err := ensureKillJob()
	if err != nil {
		return err
	}

	// PROCESS_SET_QUOTA and PROCESS_TERMINATE are what
	// AssignProcessToJobObject requires of the target.
	h, err := windows.OpenProcess(
		windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
		false,
		uint32(cmd.Process.Pid),
	)
	if err != nil {
		return fmt.Errorf("open llama-server process %d: %w", cmd.Process.Pid, err)
	}
	defer windows.CloseHandle(h)

	if err := windows.AssignProcessToJobObject(job, h); err != nil {
		return fmt.Errorf("assign llama-server to job object: %w", err)
	}
	return nil
}
