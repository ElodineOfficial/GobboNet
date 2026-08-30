// Package modelfetch downloads a catalogue model to disk and reports progress.
//
// This code was the first-run wizard's, and lived in `package setup` until the
// settings panel needed the same job done from the running server. Nothing here
// was rewritten in the move: the checksum policy, the size floor and the error
// strings were arrived at against real HuggingFace failures and are load-bearing
// exactly as they are. The only edits were exporting the identifiers the second
// caller needs, and adding Entry() so a caller can read back what it asked for.
//
// One download at a time is a policy of the *callers*, not of this type — both
// hold a single *Download and consult its state before starting another. The
// type itself is safe for concurrent status reads while Run is in flight.
package modelfetch

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/jmccardle/gobbonet/internal/catalog"
)

// SizeFloor is the backstop from launch.bat's download policy. Every catalogue
// entry is over a gigabyte, so anything smaller that arrived with a clean 200
// is an error page or an LFS pointer wearing a .gguf name.
const SizeFloor = 1 << 30

// Status is the progress snapshot both the wizard and the settings panel poll.
type Status struct {
	State   string  `json:"state"` // idle | running | done | error
	Display string  `json:"display"`
	Percent float64 `json:"percent"`
	Done    int64   `json:"done"`
	Total   int64   `json:"total"`
	Message string  `json:"message"`
}

// Download is one model transfer in flight.
type Download struct {
	entry catalog.Entry
	dir   string

	mu sync.Mutex
	st Status
}

// New prepares a download of e into dir. Call Run in a goroutine to start it.
//
// Total is seeded from the catalogue's size_gb so the bar has a scale before the
// first byte arrives; Run replaces it with the real Content-Length when the
// response carries one.
func New(e catalog.Entry, dir string) *Download {
	return &Download{entry: e, dir: dir, st: Status{
		State: "running", Display: e.Display, Total: int64(e.SizeGB * float64(1<<30)),
	}}
}

// Entry is the catalogue entry being fetched. Callers need it after the fact to
// record the model's ctx/kv tuning alongside the choice.
func (d *Download) Entry() catalog.Entry { return d.entry }

// Status returns a snapshot. Safe to call while Run is in flight.
func (d *Download) Status() Status {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.st
}

func (d *Download) set(f func(*Status)) {
	d.mu.Lock()
	f(&d.st)
	d.mu.Unlock()
}

func (d *Download) fail(msg string) {
	d.set(func(s *Status) { s.State = "error"; s.Message = msg })
}

var lfsOID = regexp.MustCompile(`(?m)^oid\s+sha256:([0-9a-fA-F]{64})\s*$`)

// Run performs the download. It blocks; call it in a goroutine and poll Status.
func (d *Download) Run() {
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		d.fail("Could not create the models folder: " + err.Error())
		return
	}
	final := filepath.Join(d.dir, d.entry.File)
	part := final + ".part"

	// Expected checksum first, so a mismatch is caught the moment the bytes are
	// on disk rather than at first load. launch.bat's policy carries over
	// verbatim: an unreachable or unparseable pointer is a warning, because an
	// upstream format change should not block a good download — the size floor
	// below is the backstop in that case. A *mismatch* is always fatal.
	var want string
	if resp, err := http.Get(d.entry.PointerURL()); err == nil {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		resp.Body.Close()
		if m := lfsOID.FindSubmatch(body); m != nil {
			want = strings.ToLower(string(m[1]))
		}
	}

	resp, err := http.Get(d.entry.DownloadURL())
	if err != nil {
		d.fail("Download failed: " + err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		d.fail(fmt.Sprintf("Download failed: the server answered %s.", resp.Status))
		return
	}
	if resp.ContentLength > 0 {
		d.set(func(s *Status) { s.Total = resp.ContentLength })
	}

	f, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		d.fail("Could not write to the models folder: " + err.Error())
		return
	}

	sum := sha256.New()
	written, err := io.Copy(io.MultiWriter(f, sum, progressWriter{d}), resp.Body)
	closeErr := f.Close()
	if err != nil {
		os.Remove(part)
		d.fail("Download interrupted: " + err.Error())
		return
	}
	if closeErr != nil {
		os.Remove(part)
		d.fail("Could not finish writing the file: " + closeErr.Error())
		return
	}

	if want != "" {
		got := hex.EncodeToString(sum.Sum(nil))
		if got != want {
			os.Remove(part)
			d.fail("Checksum mismatch — the file is corrupt or was tampered with, " +
				"so it has been deleted. Try the download again.")
			return
		}
	}

	// Backstop for the skipped-hash case. HuggingFace serves an LFS pointer of
	// a few hundred bytes instead of the model when something goes wrong
	// upstream, and it arrives as a clean 200.
	if written < SizeFloor {
		os.Remove(part)
		d.fail(fmt.Sprintf(
			"The download is only %.1f MB, which usually means an error page arrived "+
				"instead of the model. Nothing was kept.", float64(written)/(1<<20)))
		return
	}

	if err := os.Rename(part, final); err != nil {
		os.Remove(part)
		d.fail("Could not move the model into place: " + err.Error())
		return
	}

	d.set(func(s *Status) {
		s.State = "done"
		s.Percent = 100
		s.Done = written
		if want == "" {
			s.Message = "Downloaded. The published checksum could not be read, so the size was checked instead."
		} else {
			s.Message = "Downloaded and checksum verified."
		}
	})
}

type progressWriter struct{ d *Download }

func (p progressWriter) Write(b []byte) (int, error) {
	p.d.set(func(s *Status) {
		s.Done += int64(len(b))
		if s.Total > 0 {
			s.Percent = float64(s.Done) / float64(s.Total) * 100
		}
	})
	return len(b), nil
}
