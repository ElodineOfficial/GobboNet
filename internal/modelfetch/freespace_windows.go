//go:build windows

package modelfetch

import (
	"path/filepath"
	"syscall"
	"unsafe"
)

// FreeBytes reports space available to this user on the volume holding dir.
//
// This used to be reachable only from `gobbonet setup`, which is the Linux and
// macOS first-run path — on Windows the NSIS wizard does that job and runs its
// own disk check — so the note here said it existed to keep the build honest
// rather than to carry weight. That is no longer true: the settings panel's
// add-a-model download calls this on every platform, Windows included.
//
// GetDiskFreeSpaceExW's first out-parameter is the quota-aware figure for the
// calling user, which is the right one here for the same reason Bavail is on
// Unix. Returns 0 when it cannot tell, which callers treat as "do not block".
func FreeBytes(dir string) int64 {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceEx := kernel32.NewProc("GetDiskFreeSpaceExW")

	for d := dir; ; d = filepath.Dir(d) {
		p, err := syscall.UTF16PtrFromString(d)
		if err != nil {
			return 0
		}
		var freeToCaller, totalBytes, totalFree uint64
		r, _, _ := getDiskFreeSpaceEx.Call(
			uintptr(unsafe.Pointer(p)),
			uintptr(unsafe.Pointer(&freeToCaller)),
			uintptr(unsafe.Pointer(&totalBytes)),
			uintptr(unsafe.Pointer(&totalFree)),
		)
		if r != 0 {
			return int64(freeToCaller)
		}
		if parent := filepath.Dir(d); parent == d {
			return 0
		}
	}
}
