//go:build windows

package supervisor

import (
	"os/exec"
	"syscall"
)

// configureProcessGroup puts the child at the head of a new process group so
// the whole tree can be signalled at once.
//
// The Unix build uses Setpgid for the same reason: without it, llama-server's
// children outlive the kill, keep the port bound and keep VRAM allocated, and
// the replacement server dies on bind while /swap-status reports "starting".
func configureProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP,
	}
}

// terminateGroup ends the child tree.
//
// Windows has no signal that reliably reaches a detached console-less child, so
// this uses taskkill /T (tree) — the documented way to end a process and its
// descendants, and what fileserver.ps1's Stop-Process approach was reaching for.
func terminateGroup(cmd *exec.Cmd, force bool) error {
	if cmd == nil || cmd.Process == nil {
		return nil
	}
	args := []string{"/PID", itoa(cmd.Process.Pid), "/T"}
	if force {
		args = append(args, "/F")
	}
	kill := exec.Command("taskkill", args...)
	return kill.Run()
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
