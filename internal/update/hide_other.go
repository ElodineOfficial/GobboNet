//go:build !windows

package update

import "os/exec"

func hideWindow(*exec.Cmd) {}
