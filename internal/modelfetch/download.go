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
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/catalog"
	"github.com/ElodineOfficial/GobboNet/internal/models"
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
	// Stage is the step running, or the step that failed (see diagnose.go).
	// Added in 1.7.7 so a failure report says where it stopped.
	Stage string `json:"stage,omitempty"`
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
		Stage: StageFolder,
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
	logf("%s: FAILED at %s: %s", d.entry.File, d.Status().Stage, msg)
}

func (d *Download) stage(st string) {
	d.set(func(s *Status) { s.Stage = st })
}

// client is what both requests go through. http.Get used the default client,
// which has no timeouts at all: a connection that went quiet left the download
// "running" forever, at whatever percentage it had reached, with nothing to
// report. These bound the parts that should be quick; the body itself is
// bounded by stallTimeout instead, since a 20 GB transfer is meant to be long.
var client = &http.Client{
	Transport: &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   30 * time.Second,
		ResponseHeaderTimeout: 60 * time.Second,
		ForceAttemptHTTP2:     true,
		IdleConnTimeout:       90 * time.Second,
	},
}

// stallTimeout is how long the body may send nothing before the download is
// given up as stalled.
var stallTimeout = 2 * time.Minute

// stallReader cancels the request when no bytes arrive for stallTimeout. The
// read then fails, and Run reports a stall rather than hanging.
type stallReader struct {
	r     io.Reader
	timer *time.Timer
}

func (s stallReader) Read(p []byte) (int, error) {
	n, err := s.r.Read(p)
	if n > 0 {
		s.timer.Reset(stallTimeout)
	}
	return n, err
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
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	sum, err := fetchPointerSum(ctx, d.pointerURL())
	if err != nil {
		logf("%s: checksum pointer unusable (%v); the size check will be used", d.entry.File, err)
		return ""
	}
	return sum
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
	// The catalogue loaders already drop an entry whose file is not a plain
	// .gguf name. This is the second lock on the same door (1.8.0): whatever
	// built the entry, nothing is written outside the models folder.
	if err := models.CheckFileName(d.entry.File); err != nil {
		logf("%q: refused: %v", d.entry.File, err)
		d.fail("This catalogue entry's file name is not a plain model file name, so it was not downloaded.")
		return
	}
	final := filepath.Join(d.dir, d.entry.File)
	part := final + ".part"
	logf("%s: starting %s into %s", d.entry.File, d.entry.Display, d.dir)

	// Every file operation the download will need, tried first with a few
	// bytes. See checkFolder.
	d.stage(StageFolder)
	if err := checkFolder(d.dir); err != nil {
		d.fail(err.Error())
		return
	}
	logf("%s: models folder is writable", d.entry.File)
	d.stage(StageChecksum)

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

	if want == "" {
		logf("%s: no published checksum; the size check will be used", d.entry.File)
	} else {
		logf("%s: expecting sha256 %s (%s)", d.entry.File, want, verifiedBy)
	}

	d.stage(StageConnect)
	src := d.downloadURL()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, src, nil)
	if err != nil {
		d.fail("Download failed: " + err.Error())
		return
	}
	resp, err := client.Do(req)
	if err != nil {
		d.fail(explainNetErr(hostOf(src), err))
		return
	}
	defer resp.Body.Close()
	logf("%s: %s answered %s (%d bytes)", d.entry.File, hostOf(resp.Request.URL.String()), resp.Status, resp.ContentLength)
	if resp.StatusCode != http.StatusOK {
		d.fail(explainHTTPStatus(resp.StatusCode, resp.Status, d.entry.File))
		return
	}
	if resp.ContentLength > 0 {
		d.set(func(s *Status) { s.Total = resp.ContentLength })
	}

	d.stage(StageDownload)
	f, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		d.fail(explainFileErr("write the model", d.dir, err))
		return
	}

	var stalled atomic.Bool
	timer := time.AfterFunc(stallTimeout, func() { stalled.Store(true); cancel() })
	defer timer.Stop()
	body := stallReader{r: resp.Body, timer: timer}

	written, got, err := hashingCopy(io.MultiWriter(fileWriter{f}, progressWriter{d}), body)
	closeErr := f.Close()
	if err != nil {
		os.Remove(part)
		var we writeErr
		switch {
		case errors.As(err, &we):
			d.fail(explainFileErr("write the model", d.dir, we.err))
		case stalled.Load():
			d.fail(fmt.Sprintf("The download stopped: nothing arrived for %s, at %.1f GB. "+
				"The connection may have dropped. Try again.", stallTimeout, float64(written)/(1<<30)))
		default:
			d.fail(fmt.Sprintf("The download was cut off at %.1f GB. %s",
				float64(written)/(1<<30), explainNetErr(hostOf(src), err)))
		}
		return
	}
	if closeErr != nil {
		os.Remove(part)
		d.fail(explainFileErr("finish writing the model", d.dir, closeErr))
		return
	}
	logf("%s: wrote %d bytes to %s", d.entry.File, written, filepath.Base(part))
	d.stage(StageVerify)

	if want != "" {
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

	d.stage(StageMove)
	if err := moveIntoPlace(part, final); err != nil {
		os.Remove(part)
		d.fail(explainFileErr("move the model into place", d.dir, err))
		return
	}
	logf("%s: done, %s", d.entry.File, final)

	d.set(func(s *Status) {
		s.State = "done"
		s.Stage = StageDone
		s.Percent = 100
		s.Done = written
		if want == "" {
			s.Message = "Downloaded. The published checksum could not be read, so the size was checked instead."
		} else {
			s.Message = "Downloaded and checksum verified."
		}
	})
}

// fileWriter marks errors from the disk, so a failed write is explained as a
// disk problem rather than as a dropped connection -- io.Copy returns either
// kind through the same error.
type fileWriter struct{ f *os.File }

type writeErr struct{ err error }

func (e writeErr) Error() string { return e.err.Error() }
func (e writeErr) Unwrap() error { return e.err }

func (w fileWriter) Write(b []byte) (int, error) {
	n, err := w.f.Write(b)
	if err != nil {
		return n, writeErr{err}
	}
	return n, nil
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
