//go:build !windows

package mcp

import "syscall"

// alive reports whether pid still exists.
func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }
