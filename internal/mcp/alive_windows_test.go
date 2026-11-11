//go:build windows

package mcp

// alive is not checked on Windows here; the job-object tests in
// internal/supervisor cover how a tree is ended there.
func alive(pid int) bool { return false }
