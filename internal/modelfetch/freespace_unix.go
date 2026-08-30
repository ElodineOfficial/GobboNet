//go:build !windows

package modelfetch

import (
	"path/filepath"
	"syscall"
)

// FreeBytes reports space available to this user on the filesystem holding dir.
//
// It walks up to the nearest existing ancestor, because the models directory
// usually does not exist yet the first time this is asked. Returns 0 when it
// cannot tell, which callers treat as "do not block" rather than "no space" —
// refusing a download because the check failed would be worse than letting it
// run.
//
// Bavail rather than Bfree: the difference is the reserved blocks only root can
// use, and this always runs as an ordinary user.
func FreeBytes(dir string) int64 {
	for d := dir; ; d = filepath.Dir(d) {
		var st syscall.Statfs_t
		if err := syscall.Statfs(d, &st); err == nil {
			// Bsize is int64 on Linux and uint32 on Darwin; Bavail is uint64 on
			// both. The conversions make one expression work for both.
			return int64(st.Bavail) * int64(st.Bsize)
		}
		if parent := filepath.Dir(d); parent == d {
			return 0
		}
	}
}
