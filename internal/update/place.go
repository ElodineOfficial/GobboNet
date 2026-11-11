package update

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// The kinds of install, by what an update has to replace.
const (
	// KindFile: a program file in a folder this user can write to -- the
	// Windows ZIP and GobboNetSetup.exe (both per-user), the Linux ZIP.
	KindFile = "file"
	// KindAppImage: the .AppImage file itself.
	KindAppImage = "appimage"
	// KindPackage: installed by a .deb or .rpm, under /usr or /opt. The
	// package manager owns those files; replacing one behind its back would
	// leave it describing a program that is not there.
	KindPackage = "package"
	// KindReadOnly: a folder this user cannot write to.
	KindReadOnly = "readonly"
	// KindUnknown: the program's own path could not be found.
	KindUnknown = "unknown"
)

// Place is where this install's program file is and what replaces it.
type Place struct {
	Kind string `json:"kind"`
	// Path is the file an update replaces: the program, or the AppImage.
	Path string `json:"-"`
	// Target is the update file's key for this platform.
	Target string `json:"target"`
	// Reason says why an update cannot be installed here, when it cannot.
	Reason string `json:"reason,omitempty"`
}

// CanInstall reports whether UPDATE NOW can work here.
func (p Place) CanInstall() bool {
	return (p.Kind == KindFile || p.Kind == KindAppImage) && p.Path != "" && p.Target != ""
}

// Locate finds this install. Call it once, at startup: after an update has
// moved the running program aside, os.Executable on Linux names the moved
// file.
func Locate() Place {
	exe, err := os.Executable()
	if err == nil {
		if resolved, rerr := filepath.EvalSymlinks(exe); rerr == nil {
			exe = resolved
		}
	} else {
		exe = ""
	}
	return locate(runtime.GOOS, runtime.GOARCH, exe, os.Getenv("APPIMAGE"), os.Getenv("APPDIR"), dirWritable)
}

func locate(goos, goarch, exe, appImage, appDir string, writable func(string) bool) Place {
	if exe == "" {
		return Place{Kind: KindUnknown, Reason: "GobboNet could not find its own program file, so it cannot replace it."}
	}
	if goos == "linux" {
		if img := appImageOf(exe, appImage, appDir); img != "" {
			p := Place{Kind: KindAppImage, Path: img, Target: "appimage-" + goarch}
			if !writable(filepath.Dir(img)) {
				p.Kind = KindReadOnly
				p.Reason = "GobboNet cannot write to the folder its AppImage is in (" + filepath.Dir(img) + "). Download the new AppImage from the release page instead."
			}
			return p
		}
		for _, prefix := range []string{"/usr/", "/opt/"} {
			if strings.HasPrefix(exe, prefix) {
				return Place{Kind: KindPackage, Path: exe, Target: goos + "-" + goarch,
					Reason: "This copy was installed from a .deb or .rpm package. Install the new package from the release page over it; your chats, models and settings are kept."}
			}
		}
	}
	p := Place{Kind: KindFile, Path: exe, Target: goos + "-" + goarch}
	if !writable(filepath.Dir(exe)) {
		p.Kind = KindReadOnly
		p.Reason = "GobboNet cannot write to its own folder (" + filepath.Dir(exe) + "). Download the update from the release page and replace the program file by hand."
	}
	return p
}

// appImageOf returns the .AppImage file this binary is running from, or "".
// The same test as `gobbonet uninstall` (cmd/gobbonet/uninstall.go): the
// runtime hands APPIMAGE and APPDIR to every child, so the binary has to be
// inside APPDIR for APPIMAGE to be about GobboNet.
func appImageOf(exe, appImage, appDir string) string {
	if appImage == "" || appDir == "" || exe == "" {
		return ""
	}
	rel, err := filepath.Rel(filepath.Clean(appDir), filepath.Clean(exe))
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return ""
	}
	return appImage
}

// dirWritable tries what an update does: create a file in dir.
func dirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".gobbonet-update-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}
