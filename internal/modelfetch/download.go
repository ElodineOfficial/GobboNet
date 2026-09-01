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

	// requireChecksum refuses a download that no source can vouch for, rather
	// than falling back to the size floor. Off by default because the shipped
	// models.ini carries no hashes and the live catalogue still publishes null
	// for every entry — defaulting it on would break every stock install.
	requireChecksum bool

	// hostBase overrides HuggingFace's address; set only by tests.
	hostBase string
	// sizeFloor overrides SizeFloor; set only by tests, which cannot serve a
	// gigabyte to clear the real one.
	sizeFloor int64

	mu sync.Mutex
	st Status
}

// Option adjusts a Download at construction.
type Option func(*Download)

// RequireChecksum makes an unverifiable download an error instead of a warning.
//
// Worth turning on for a catalogue you control, where every entry has a pin and
// a missing one means the catalogue is wrong rather than merely old.
func RequireChecksum(on bool) Option {
	return func(d *Download) { d.requireChecksum = on }
}

// New prepares a download of e into dir. Call Run in a goroutine to start it.
//
// Total is seeded from the catalogue's size_gb so the bar has a scale before the
// first byte arrives; Run replaces it with the real Content-Length when the
// response carries one.
func New(e catalog.Entry, dir string, opts ...Option) *Download {
	d := &Download{entry: e, dir: dir, st: Status{
		State: "running", Display: e.Display, Total: int64(e.SizeGB * float64(1<<30)),
	}}
	for _, opt := range opts {
		opt(d)
	}
	return d
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

// expectedSum resolves the hash this download must match, and names the source
// that supplied it so a mismatch can say which one disagreed.
func (d *Download) expectedSum() (sum, source string, err error) {
	return d.crossCheck(d.pointerSum())
}

// crossCheck weighs the catalogue's pin against the hash HuggingFace records.
//
// Kept free of I/O so the precedence rules can be tested directly. Returns an
// empty hash when neither source has one; that is not an error here, because
// models.ini has never carried the field and the live catalogue still publishes
// null for every entry. Run's size floor remains the backstop, and
// require_checksum is there for anyone who wants the stricter rule.
func (d *Download) crossCheck(pointer string) (sum, source string, err error) {
	pin := strings.ToLower(strings.TrimSpace(d.entry.SHA256))
	pointer = strings.ToLower(strings.TrimSpace(pointer))

	switch {
	case pin != "" && pointer != "" && pin != pointer:
		// Two independent sources that should agree, and do not. This is the
		// one case the cross-check exists to catch, so it stops here rather
		// than picking a winner: whichever is wrong, downloading gigabytes to
		// compare against a hash already known to be disputed is pointless, and
		// silently preferring the pin would hide a catalogue that has drifted
		// from the file it describes.
		return "", "", fmt.Errorf(
			"refusing to download %s: the catalogue and HuggingFace disagree about "+
				"its checksum, so one of them is wrong or the file has been replaced.\n\n"+
				"  catalogue says:   %s\n"+
				"  HuggingFace says: %s\n\n"+
				"Nothing was downloaded. If you maintain this catalogue, re-check the "+
				"entry for %s.", d.entry.Display, pin, pointer, d.entry.File)

	case pin != "" && pointer != "":
		return pin, "checksum published by the catalogue and confirmed by HuggingFace", nil

	case pin != "":
		// The pointer is missing — unreachable, or an upstream format change.
		// The pin still verifies the bytes; it simply was not corroborated, and
		// the wording must not imply otherwise.
		return pin, "checksum published by the catalogue", nil

	case pointer != "":
		return pointer, "checksum HuggingFace records for this file", nil
	}
	return "", "", nil
}

// pointerSum reads the hash HuggingFace records for the file.
//
// HuggingFace stores GGUFs in LFS, so /raw/ returns a pointer of a few lines
// rather than the weights. An unreachable or unparseable pointer is empty and
// not an error, carrying over launch.bat's policy verbatim: an upstream format
// change should not block a good download.
func (d *Download) pointerSum() string {
	resp, err := http.Get(d.pointerURL())
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return ""
	}
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	if m := lfsOID.FindSubmatch(body); m != nil {
		return strings.ToLower(string(m[1]))
	}
	return ""
}

// hostBase overrides HuggingFace's address. Empty in every shipping path; set
// only by tests, so the download path can be exercised without reaching the
// real host — which would make the suite depend on the network and on a
// third party's uptime.
func (d *Download) downloadURL() string {
	if d.hostBase == "" {
		return d.entry.DownloadURL()
	}
	return d.hostBase + "/" + d.entry.Repo + "/resolve/main/" + d.entry.File
}

func (d *Download) pointerURL() string {
	if d.hostBase == "" {
		return d.entry.PointerURL()
	}
	return d.hostBase + "/" + d.entry.Repo + "/raw/main/" + d.entry.File
}

// Run performs the download. It blocks; call it in a goroutine and poll Status.
func (d *Download) Run() {
	if err := os.MkdirAll(d.dir, 0o700); err != nil {
		d.fail("Could not create the models folder: " + err.Error())
		return
	}
	final := filepath.Join(d.dir, d.entry.File)
	part := final + ".part"

	// Work out the expected checksum before a byte is written, so a mismatch is
	// caught the moment the bytes are on disk rather than at first load.
	//
	// Two sources, and they are not equal in weight:
	//
	//   - entry.SHA256 is the catalogue's pin. It did NOT come from the host
	//     serving the weights, so it establishes authenticity: HuggingFace and
	//     the catalogue publisher would both have to lie, in agreement.
	//   - the LFS pointer comes from HuggingFace, the same host as the file.
	//     It proves the transfer was not corrupted and nothing more.
	//
	// The pin wins where both exist, and disagreement is fatal before any
	// download starts. Until now nothing read entry.SHA256 at all: the field
	// was parsed, validated and stored by the catalogue, and the downloader
	// went on consulting only the pointer. The cross-check the design
	// documents was wired to a dead end.
	want, verifiedBy, err := d.expectedSum()
	if err != nil {
		d.fail(err.Error())
		return
	}
	if want == "" && d.requireChecksum {
		d.fail("This model has no published checksum, and require_checksum is on, " +
			"so nothing was downloaded. Add a sha256 for it to the catalogue, or " +
			"turn require_checksum off to accept unverified downloads.")
		return
	}

	resp, err := http.Get(d.downloadURL())
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
			d.fail(fmt.Sprintf(
				"Checksum mismatch against the %s — the file is corrupt or was "+
					"tampered with, so it has been deleted. Expected %s, got %s. "+
					"Try the download again.", verifiedBy, want, got))
			return
		}
	}

	// Backstop for the skipped-hash case. HuggingFace serves an LFS pointer of
	// a few hundred bytes instead of the model when something goes wrong
	// upstream, and it arrives as a clean 200.
	floor := int64(SizeFloor)
	if d.sizeFloor > 0 {
		floor = d.sizeFloor
	}
	if written < floor {
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
