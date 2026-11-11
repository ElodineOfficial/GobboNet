//go:build windows

package update

import (
	"os/exec"
	"syscall"
)

// hideWindow keeps the new program's `version --json` from flashing a
// console window when GobboNet itself has none.
func hideWindow(cmd *exec.Cmd) {
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNoWindow, HideWindow: true}
}
