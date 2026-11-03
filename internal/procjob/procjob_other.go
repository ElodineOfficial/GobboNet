//go:build !windows

package procjob

import "os/exec"

// TieToLifetime is a no-op outside Windows. The Unix launchers do not run
// launch.bat, and the near-equivalents of a kill-on-close job are worse than
// the gap; internal/supervisor/killjob_unix.go has the reasoning.
func TieToLifetime(cmd *exec.Cmd) error { return nil }

// StartDetached is a plain Start outside Windows: there is no job to leave.
func StartDetached(cmd *exec.Cmd) error { return cmd.Start() }
