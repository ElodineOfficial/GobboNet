package catalog

import (
	"os"
	"path/filepath"
)

// Discover returns the path to models.ini, or "" if it isn't anywhere obvious.
//
// This search order was `findCatalog()` in cmd/gobbonet, where only the setup
// wizard could reach it. The running server now needs the same catalogue for
// the settings panel's add-a-model modal, and two copies of a lookup order
// diverge the moment a packaging path changes — so it moved here rather than
// being written a second time.
//
// The order covers a .deb or .rpm install first, then the directory the binary
// sits in (which is where the Windows installer and a portable unzip put it),
// then a developer's checkout.
func Discover() string {
	candidates := []string{"/usr/lib/gobbonet/models.ini"}
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates,
			filepath.Join(dir, "models.ini"),
			filepath.Join(dir, "installer", "models.ini"),
		)
	}
	candidates = append(candidates, "installer/models.ini", "models.ini")
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	return ""
}
