//go:build !windows

package supervisor

import "os/exec"

// superviseTree is the Unix half of the Windows job-object backstop, and it
// deliberately does nothing.
//
// The Windows build ties llama-server to a job object with
// KILL_ON_JOB_CLOSE, so the kernel kills it when gobbonet dies for any reason
// — including a SIGKILL that runs no Go code. There is no portable equivalent
// here, and the near-equivalents are worse than the gap:
//
// Linux has prctl(PR_SET_PDEATHSIG), which os/exec exposes as
// SysProcAttr.Pdeathsig. It fires on the death of the creating THREAD, not the
// process, and Go gives no guarantee that the runtime thread which happened to
// fork the child outlives it. A retired thread would deliver SIGKILL to a
// healthy llama-server in the middle of a generation. Trading a rare leak after
// an abnormal exit for a random kill during normal operation is a bad trade, so
// it is not taken.
//
// macOS and the BSDs have nothing in this shape at all.
//
// What remains on Unix is the process-group handling in process_unix.go, which
// covers every path where gobbonet runs its own cleanup: Ctrl+C, SIGTERM, a
// swap, a crash of the child. Only a SIGKILL of gobbonet itself leaks, and on
// Unix that is a deliberate act rather than the routine "close the window"
// gesture it is on Windows.
func superviseTree(cmd *exec.Cmd) error { return nil }
