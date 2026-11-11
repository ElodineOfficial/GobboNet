package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"time"
)

// Install stages, as /update/status reports them.
const (
	StageDownloading = "downloading"
	StageChecking    = "checking"
	StageInstalling  = "installing"
)

// stallTimeout is how long a download may receive nothing before it is given
// up on. A var so a test can shorten it.
var stallTimeout = 2 * time.Minute

// smokeTimeout bounds `<new program> version --json`. An AppImage has to be
// mounted first, which is the slow part.
const smokeTimeout = 90 * time.Second

// Stamp is what `gobbonet version --json` prints.
type Stamp struct {
	Build   string `json:"build"`
	Version string `json:"version"`
	Serial  int64  `json:"serial"`
	GOOS    string `json:"goos"`
	GOARCH  string `json:"goarch"`
}

// Installer downloads an offer, checks it and puts it in place.
type Installer struct {
	Client *http.Client
	// WorkDir holds a downloaded archive while the program is taken out of
	// it. The program itself is always written beside the file it replaces,
	// so that the last step is a rename on one filesystem.
	WorkDir string
	// Progress is told each stage, and bytes as they arrive. May be nil.
	Progress func(stage string, done, total int64)
	// Smoke runs the new program and reads its stamp. nil means RunStamp.
	Smoke func(ctx context.Context, path string) (Stamp, error)
}

// Installed is a finished install.
type Installed struct {
	Build Build
	// Old is where the replaced file was moved. It is removed the next time
	// GobboNet starts (CleanupOld), by which time the new one has run.
	Old string
}

func (in *Installer) progress(stage string, done, total int64) {
	if in.Progress != nil {
		in.Progress(stage, done, total)
	}
}

// Install puts offer in place of place.Path. Nothing is replaced unless every
// check passes: the archive's size and SHA-256, the program's size and
// SHA-256, and the new program itself reporting the build the signed update
// file promised. A failure at the last step moves the old file back.
func (in *Installer) Install(ctx context.Context, offer *Offer, place Place) (*Installed, error) {
	if offer == nil || offer.TargetKey == "" {
		return nil, errors.New("this release has no download for this platform")
	}
	if !place.CanInstall() {
		return nil, errors.New(place.Reason)
	}
	if offer.TargetKey != place.Target {
		return nil, fmt.Errorf("the download is for %s, and this is %s", offer.TargetKey, place.Target)
	}
	t := offer.Target
	newPath := NewPathFor(place.Path)
	os.Remove(newPath)
	fail := func(err error) (*Installed, error) {
		os.Remove(newPath)
		return nil, err
	}

	// 1. Download. An archive goes to WorkDir; a program that is the asset
	// itself (an AppImage) straight to newPath.
	dest := newPath
	if t.Member != "" {
		if err := os.MkdirAll(in.WorkDir, 0o700); err != nil {
			return fail(fmt.Errorf("could not make %s: %v", in.WorkDir, err))
		}
		dest = filepath.Join(in.WorkDir, t.Asset+".part")
		defer os.Remove(dest)
	}
	sum, err := in.download(ctx, offer.Asset.URL, dest, t.Size)
	if err != nil {
		return fail(err)
	}
	in.progress(StageChecking, t.Size, t.Size)
	if sum != t.SHA256 {
		return fail(fmt.Errorf("the download does not match the signed update file (SHA-256 %s, expected %s), so it was thrown away", short(sum), short(t.SHA256)))
	}

	// 2. Take the program out of the archive.
	if t.Member != "" {
		msum, err := extract(dest, archiveKind(t.Asset), t.Member, t.MemberSize, newPath)
		if err != nil {
			return fail(err)
		}
		if msum != t.MemberSHA256 {
			return fail(fmt.Errorf("the program in the download does not match the signed update file (SHA-256 %s, expected %s)", short(msum), short(t.MemberSHA256)))
		}
	}
	if err := os.Chmod(newPath, 0o755); err != nil {
		return fail(err)
	}

	// 3. Run it. A program that will not start, or that is not the build the
	// update file named, is not put in place.
	smoke := in.Smoke
	if smoke == nil {
		smoke = RunStamp
	}
	sctx, cancel := context.WithTimeout(ctx, smokeTimeout)
	stamp, err := smoke(sctx, newPath)
	cancel()
	if err != nil {
		return fail(fmt.Errorf("the new program would not start here: %v", err))
	}
	want := offer.Manifest
	if stamp.Build != want.Build || stamp.Serial != want.Serial {
		return fail(fmt.Errorf("the new program reports %s (serial %d), not %s (serial %d) as the update file says", stamp.Build, stamp.Serial, want.Build, want.Serial))
	}
	if stamp.GOOS != runtime.GOOS || stamp.GOARCH != runtime.GOARCH {
		return fail(fmt.Errorf("the new program is for %s/%s, and this is %s/%s", stamp.GOOS, stamp.GOARCH, runtime.GOOS, runtime.GOARCH))
	}

	// 4. Swap. A running program can be renamed on Windows (not deleted), and
	// on Linux the running one keeps its file open whatever its name.
	in.progress(StageInstalling, t.Size, t.Size)
	old, err := swap(place.Path, newPath)
	if err != nil {
		return fail(err)
	}
	return &Installed{Build: want.Of(), Old: old}, nil
}

// NewPathFor is where the new program is written before it is swapped in:
// beside the old one, so the swap is a rename on one filesystem. On Windows
// it keeps .exe last -- gobbonet.new.exe -- so that it can be run for the
// check before the swap like any program.
func NewPathFor(target string) string {
	if strings.EqualFold(filepath.Ext(target), ".exe") {
		return strings.TrimSuffix(target, filepath.Ext(target)) + ".new" + filepath.Ext(target)
	}
	return target + ".new"
}

// renameRetry is os.Rename, tried again for a few seconds when it fails for a
// reason other than a missing file: on Windows a virus scanner opens a new
// program file to look at it, and the file cannot be moved until it is done.
func renameRetry(from, to string) error {
	var err error
	for i := 0; i < 15; i++ {
		if err = os.Rename(from, to); err == nil || errors.Is(err, os.ErrNotExist) {
			return err
		}
		time.Sleep(200 * time.Millisecond)
	}
	return err
}

func short(sum string) string {
	if len(sum) > 12 {
		return sum[:12] + "..."
	}
	return sum
}

// swap moves path aside to path.old and newPath into its place, and moves it
// back if the second rename fails.
func swap(target, newPath string) (string, error) {
	old := target + ".old"
	if err := os.Remove(old); err != nil && !errors.Is(err, os.ErrNotExist) {
		// A .old still in use (Windows) cannot be removed; take another name.
		old = fmt.Sprintf("%s.old-%d", target, time.Now().UnixNano())
	}
	if err := renameRetry(target, old); err != nil {
		return "", fmt.Errorf("could not move the current program aside: %v", err)
	}
	if err := renameRetry(newPath, target); err != nil {
		if berr := renameRetry(old, target); berr != nil {
			return "", fmt.Errorf("could not put the new program in place (%v), and could not move the old one back (%v): it is at %s", err, berr, old)
		}
		return "", fmt.Errorf("could not put the new program in place: %v", err)
	}
	return old, nil
}

// CleanupOld removes what an earlier update left beside path: the program it
// replaced, and a download that never finished. It reports what it removed
// and what it could not; on Windows the replaced program may still be
// exiting.
func CleanupOld(target string) (removed, left []string) {
	if target == "" {
		return nil, nil
	}
	// Listed rather than globbed: a folder named "GobboNet [2]" is a pattern.
	var matches []string
	dir, base := filepath.Split(target)
	newBase := filepath.Base(NewPathFor(target))
	if entries, err := os.ReadDir(filepath.Clean(dir)); err == nil {
		for _, e := range entries {
			if n := e.Name(); n == newBase || n == base+".old" || strings.HasPrefix(n, base+".old-") {
				matches = append(matches, filepath.Join(dir, n))
			}
		}
	}
	for _, m := range matches {
		err := os.Remove(m)
		switch {
		case err == nil:
			removed = append(removed, m)
		case !errors.Is(err, os.ErrNotExist):
			left = append(left, m)
		}
	}
	return removed, left
}

// download fetches u into dest, refusing anything that is not exactly size
// bytes, and returns its SHA-256.
func (in *Installer) download(ctx context.Context, u, dest string, size int64) (string, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", err
	}
	setHeaders(req, "application/octet-stream")
	resp, err := in.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("the download could not start: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("the download answered HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > 0 && resp.ContentLength != size {
		return "", fmt.Errorf("the download is %d bytes; the update file says %d", resp.ContentLength, size)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return "", fmt.Errorf("could not write the download: %v", err)
	}
	h := sha256.New()
	var stalled atomic.Bool
	timer := time.AfterFunc(stallTimeout, func() { stalled.Store(true); cancel() })
	defer timer.Stop()
	pr := &progressReader{r: resp.Body, h: h, timer: timer, total: size, report: func(done int64) {
		in.progress(StageDownloading, done, size)
	}}
	n, err := io.Copy(f, io.LimitReader(pr, size+1))
	cerr := f.Close()
	if err != nil {
		if stalled.Load() {
			return "", errors.New("the download stalled: nothing arrived for two minutes")
		}
		return "", fmt.Errorf("the download failed: %v", err)
	}
	if cerr != nil {
		return "", fmt.Errorf("could not write the download: %v", cerr)
	}
	if n != size {
		return "", fmt.Errorf("the download is %d bytes; the update file says %d", n, size)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

type progressReader struct {
	r      io.Reader
	h      hash.Hash
	timer  *time.Timer
	done   int64
	total  int64
	last   time.Time
	report func(int64)
}

func (p *progressReader) Read(b []byte) (int, error) {
	n, err := p.r.Read(b)
	if n > 0 {
		p.h.Write(b[:n])
		p.timer.Reset(stallTimeout)
		p.done += int64(n)
		if time.Since(p.last) > 200*time.Millisecond || p.done >= p.total {
			p.last = time.Now()
			p.report(p.done)
		}
	}
	return n, err
}

// extract copies member out of the archive at src into dest and returns its
// SHA-256. The member must be a regular file of exactly size bytes.
func extract(src, kind, member string, size int64, dest string) (string, error) {
	var r io.Reader
	var closeFn func()
	switch kind {
	case "zip":
		zr, err := zip.OpenReader(src)
		if err != nil {
			return "", fmt.Errorf("the download is not a readable ZIP: %v", err)
		}
		defer zr.Close()
		var found *zip.File
		for _, f := range zr.File {
			if f.Name == member {
				found = f
				break
			}
		}
		if found == nil {
			return "", fmt.Errorf("the download has no %s in it", member)
		}
		if !found.Mode().IsRegular() || found.UncompressedSize64 != uint64(size) {
			return "", fmt.Errorf("%s in the download is not the file the update file describes", member)
		}
		rc, err := found.Open()
		if err != nil {
			return "", err
		}
		r, closeFn = rc, func() { rc.Close() }
	case "tgz":
		f, err := os.Open(src)
		if err != nil {
			return "", err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return "", fmt.Errorf("the download is not a readable .tar.gz: %v", err)
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				return "", fmt.Errorf("the download has no %s in it", member)
			}
			if err != nil {
				return "", fmt.Errorf("the download is not a readable .tar.gz: %v", err)
			}
			if path.Clean(strings.TrimPrefix(hdr.Name, "./")) != member {
				continue
			}
			if hdr.Typeflag != tar.TypeReg || hdr.Size != size {
				return "", fmt.Errorf("%s in the download is not the file the update file describes", member)
			}
			r, closeFn = tr, func() {}
			break
		}
	default:
		return "", errors.New("the download is not an archive this build can open")
	}
	defer closeFn()

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return "", fmt.Errorf("could not write the new program beside the old one: %v", err)
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(r, size+1))
	cerr := out.Close()
	if err != nil {
		return "", fmt.Errorf("could not take the program out of the download: %v", err)
	}
	if cerr != nil {
		return "", cerr
	}
	if n != size {
		return "", fmt.Errorf("%s in the download is %d bytes, not %d", member, n, size)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// RunStamp runs `<program> version --json` and reads what it prints.
func RunStamp(ctx context.Context, program string) (Stamp, error) {
	return runStamp(ctx, program, nil)
}

func runStamp(ctx context.Context, program string, extraEnv []string) (Stamp, error) {
	cmd := exec.CommandContext(ctx, program, "version", "--json")
	cmd.Env = append(append(os.Environ(), "GOBBONET_BANNER_SHOWN=1"), extraEnv...)
	hideWindow(cmd)
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return Stamp{}, errors.New("it did not answer in time")
	}
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return Stamp{}, fmt.Errorf("%v: %s", err, strings.TrimSpace(string(ee.Stderr)))
		}
		return Stamp{}, err
	}
	// The last line: an AppImage's runtime may print before the program does.
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	var s Stamp
	if err := json.Unmarshal([]byte(strings.TrimSpace(lines[len(lines)-1])), &s); err != nil || s.Build == "" {
		return Stamp{}, errors.New("it does not report its version (is it a GobboNet older than 1.8.0?)")
	}
	return s, nil
}
