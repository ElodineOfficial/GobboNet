// Package engine fetches the pinned llama.cpp build.
//
// # WHY THIS EXISTS
//
// launch.bat has always been able to download the engine: STEP 1 fetches ~300 MB
// of llama.cpp, checks it against a pinned SHA-256 and unpacks it. gobbonet
// could not. It took a path handed to it by whoever launched it
// (internal/setup's --server-exe) and reported has_engine:false otherwise.
//
// That was survivable while launch.bat ran the show. It stopped being survivable
// the moment launch.bat started handing over to gobbonet.exe before STEP 1: a
// Windows user extracting the ZIP — which carries no Windows engine — went
// straight to a setup that could not get one. A capability that existed in 1.7.3
// was unreachable, which is a regression whatever the reason for it.
//
// So the downloader lives here, on the side that is now the front door. The pin
// is the same one every builder reads (engine.sha256 at the repo root), the
// hash policy is launch.bat's — a mismatch is fatal, a missing pin is a refusal
// rather than a shrug — and nothing here is platform-specific beyond choosing
// which asset to ask for.
package engine

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// Pin is the engine build every GobboNet artifact is supposed to carry.
type Pin struct {
	Build  string // e.g. "b10456"
	Asset  string // the release asset filename
	SHA256 string // lower-case hex
	URL    string
}

// releaseBase is upstream's download root. A var so a test can point it at a
// local server without reaching the network.
var releaseBase = "https://github.com/ggml-org/llama.cpp/releases/download"

// ParsePin reads engine.sha256 and works out which asset this platform needs.
//
// The file is the single source of truth shared with build-installer.sh,
// build-deb.sh and build-rpm.sh. Reading it rather than hardcoding a build here
// is the same rule VERSION already follows: one literal, read by everyone. The
// two things in this project that went stale on their own were both hardcoded
// literals.
func ParsePin(path string) (Pin, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Pin{}, err
	}
	fields := map[string]string{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		fields[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}

	build := fields["LLAMA_BUILD"]
	if build == "" {
		return Pin{}, fmt.Errorf("%s does not name an LLAMA_BUILD", path)
	}

	// Which asset, and which hash goes with it. Only the combinations the
	// project actually pins are offered: claiming to support a platform whose
	// hash is not in the file would mean downloading something unverifiable,
	// which is the one thing the pin exists to prevent.
	var asset, shaKey string
	switch runtime.GOOS {
	case "windows":
		asset, shaKey = "llama-"+build+"-bin-win-vulkan-x64.zip", "WIN_GPU_SHA256"
	case "linux":
		asset, shaKey = "llama-"+build+"-bin-ubuntu-vulkan-x64.zip", "GPU_SHA256"
	default:
		return Pin{}, fmt.Errorf("no pinned llama.cpp build for %s; install one yourself and "+
			"point server_exe at it", runtime.GOOS)
	}
	sum := strings.ToLower(fields[shaKey])
	if sum == "" {
		return Pin{}, fmt.Errorf("%s has no %s, so %s could not be verified if it were "+
			"downloaded", path, shaKey, asset)
	}
	return Pin{
		Build:  build,
		Asset:  asset,
		SHA256: sum,
		URL:    releaseBase + "/" + build + "/" + asset,
	}, nil
}

// DiscoverPin finds engine.sha256 beside the binary or in the working
// directory, the same two places everything else in this program looks.
func DiscoverPin(exeDir, workDir string) (Pin, error) {
	for _, d := range []string{exeDir, workDir} {
		if d == "" {
			continue
		}
		p := filepath.Join(d, "engine.sha256")
		if _, err := os.Stat(p); err == nil {
			return ParsePin(p)
		}
	}
	return Pin{}, errors.New("engine.sha256 not found beside the program or in this folder")
}

// Installed reports the llama-server inside dir, or "" if there is not one.
func Installed(dir string) string {
	name := "llama-server"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	p := filepath.Join(dir, name)
	if st, err := os.Stat(p); err == nil && !st.IsDir() {
		return p
	}
	return ""
}

// Install downloads the pinned engine into dir and returns the llama-server
// path. progress, when non-nil, is called with human-readable steps.
//
// The hash policy is launch.bat's, deliberately: a mismatch is fatal and the
// partial file is removed. A download that cannot be vouched for is worse than
// no download, because it is the one a user would then run.
func Install(pin Pin, dir string, progress func(string)) (string, error) {
	say := func(format string, a ...any) {
		if progress != nil {
			progress(fmt.Sprintf(format, a...))
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}

	archive := filepath.Join(dir, pin.Asset)
	part := archive + ".part"
	_ = os.Remove(part)

	say("downloading %s (about 300 MB; this is the only large download)", pin.Asset)
	if err := download(pin.URL, part, say); err != nil {
		_ = os.Remove(part)
		return "", err
	}

	say("checking it against the pinned SHA-256")
	sum, err := sha256File(part)
	if err != nil {
		_ = os.Remove(part)
		return "", err
	}
	if !strings.EqualFold(sum, pin.SHA256) {
		_ = os.Remove(part)
		return "", fmt.Errorf("SHA-256 mismatch for %s\n"+
			"       expected %s\n"+
			"       got      %s\n"+
			"       The download is corrupt or tampered with; nothing was installed.",
			pin.Asset, pin.SHA256, sum)
	}
	say("checksum verified")

	if err := os.Rename(part, archive); err != nil {
		return "", err
	}
	defer os.Remove(archive)

	say("extracting")
	if err := unzip(archive, dir); err != nil {
		return "", err
	}

	exe := Installed(dir)
	if exe == "" {
		return "", fmt.Errorf("%s unpacked but contains no llama-server", pin.Asset)
	}
	// A note beside the engine saying which build it is, matching the
	// ENGINE.txt the installers write. Without it the bundled engine is
	// anonymous once installed, and "which engine are you running" becomes
	// unanswerable after the fact.
	_ = os.WriteFile(filepath.Join(dir, "ENGINE.txt"), []byte(
		"llama.cpp build: "+pin.Build+"\n"+
			"asset:           "+pin.Asset+"\n"+
			"pinned hash:     "+pin.SHA256+"\n"+
			"verified:        yes (sha256 matches the pin)\n"+
			"installed by:    gobbonet engine install\n"), 0o644)

	say("engine ready: %s", exe)
	return exe, nil
}

func download(url, dest string, say func(string, ...any)) error {
	client := &http.Client{Timeout: 60 * time.Minute}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("could not reach %s: %w", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("%s returned HTTP %d", url, resp.StatusCode)
	}

	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()

	// Progress, because a silent 300 MB download is the thing that makes people
	// kill the window -- the same reason the engine's own output is on screen.
	var done int64
	last := time.Now()
	buf := make([]byte, 1<<20)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				return werr
			}
			done += int64(n)
			if time.Since(last) > 2*time.Second {
				if resp.ContentLength > 0 {
					say("  %d%% (%d MB of %d MB)", done*100/resp.ContentLength,
						done>>20, resp.ContentLength>>20)
				} else {
					say("  %d MB", done>>20)
				}
				last = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return rerr
		}
	}
	if resp.ContentLength > 0 && done != resp.ContentLength {
		return fmt.Errorf("download ended early: %d of %d bytes", done, resp.ContentLength)
	}
	return nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// unzip extracts into dir, flattening the archive's own top-level folder.
//
// Upstream's archives put everything under build/bin/, and the rest of GobboNet
// expects llama-server to sit directly in llama-cpp/ -- that is where
// Installed() and every server_exe written by the installers point.
func unzip(archive, dir string) error {
	zr, err := zip.OpenReader(archive)
	if err != nil {
		return err
	}
	defer zr.Close()

	for _, f := range zr.File {
		// Zip-slip: an entry named ../../x would otherwise be written outside
		// dir. The name is attacker-controlled in principle -- it comes out of a
		// downloaded file -- so it is checked even though the archive's hash was
		// verified first.
		name := strings.ReplaceAll(f.Name, "\\", "/")
		if strings.Contains(name, "..") || strings.HasPrefix(name, "/") {
			continue
		}
		// Flatten: keep only the basename for files, which is what puts
		// build/bin/llama-server at llama-cpp/llama-server.
		if f.FileInfo().IsDir() {
			continue
		}
		target := filepath.Join(dir, filepath.Base(name))
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, modeFor(f))
		if err != nil {
			rc.Close()
			return err
		}
		_, cerr := io.Copy(out, rc)
		rc.Close()
		out.Close()
		if cerr != nil {
			return cerr
		}
	}
	return nil
}

// modeFor keeps the executable bit on binaries and shared objects. Windows
// ignores the mode; Linux will not run llama-server without it.
func modeFor(f *zip.File) os.FileMode {
	if m := f.Mode(); m&0o111 != 0 {
		return 0o755
	}
	name := strings.ToLower(filepath.Base(f.Name))
	if strings.HasPrefix(name, "llama-") || strings.Contains(name, ".so") {
		return 0o755
	}
	return 0o644
}
