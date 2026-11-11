package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// legacyLeftovers are the files the 1.7 PowerShell server left in the install
// folder. 1.8.0 removed that server. The Windows installer deletes them, but an
// update made by extracting a ZIP cannot delete anything, so they can linger.
// Nothing reads them; this only says so, and deletes nothing itself.
var legacyLeftovers = []string{"fileserver.ps1", "fileserver.log"}

// reportLegacyLeftovers names any of legacyLeftovers found in dir, the install
// folder, and prints nothing at all when there are none.
func reportLegacyLeftovers(w io.Writer, dir string) {
	if dir == "" {
		return
	}
	var found []string
	for _, name := range legacyLeftovers {
		if st, err := os.Stat(filepath.Join(dir, name)); err == nil && !st.IsDir() {
			found = append(found, filepath.Join(dir, name))
		}
	}
	if len(found) == 0 {
		return
	}
	fmt.Fprintln(w)
	fmt.Fprintln(w, "LEFTOVERS FROM 1.7")
	for _, path := range found {
		fmt.Fprintf(w, "  %s\n", path)
	}
	fmt.Fprintln(w, "               The PowerShell server GobboNet 1.7 used, and its log.")
	fmt.Fprintln(w, "               1.8 removed it and nothing runs it any more, so you can")
	fmt.Fprintln(w, "               delete these. A ZIP update cannot delete files, which is")
	fmt.Fprintln(w, "               why they are still here; the installer removes them.")
}

// installDir is the folder this binary runs from, or "" if that is unknown.
func installDir() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Dir(exe)
}
