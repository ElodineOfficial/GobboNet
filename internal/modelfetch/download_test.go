package modelfetch

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/jmccardle/gobbonet/internal/catalog"
)

// The download path has two possible sources for an expected hash, and they are
// not equal in weight:
//
//   - the catalogue's pin does NOT come from the host serving the weights, so
//     it establishes authenticity;
//   - HuggingFace's LFS pointer comes from the same host as the file, so it
//     proves the transfer was not corrupted and nothing more.
//
// Until this change nothing read the catalogue pin at all. These tests pin the
// precedence, the cross-check, and the compatibility fallback.

func sum(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// fakeHF serves a model file and its LFS pointer on the paths Entry builds.
// pointerSum of "" omits the pointer entirely, standing in for an upstream
// format change or an unreachable /raw/.
func fakeHF(t *testing.T, body []byte, pointerSum string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/resolve/"):
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Write(body)
		case strings.Contains(r.URL.Path, "/raw/"):
			if pointerSum == "" {
				http.NotFound(w, r)
				return
			}
			w.Write([]byte("version https://git-lfs.github.com/spec/v1\noid sha256:" +
				pointerSum + "\nsize 4\n"))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func testEntry(sha string) catalog.Entry {
	return catalog.Entry{
		Index:   1,
		Display: "Test Model",
		Repo:    "owner/repo",
		File:    "model.gguf",
		SHA256:  sha,
	}
}

// TestCataloguePinIsUsed is the dead end this change closes. The field was
// parsed, validated and stored by the catalogue, and the downloader never read
// it — so a published hash verified nothing.
func TestCataloguePinIsUsed(t *testing.T) {
	body := []byte("weights")
	srv := fakeHF(t, body, "") // no pointer, so only the pin can answer
	d := New(testEntry(sum(body)), t.TempDir())
	d.hostBase = srv.URL

	want, source, err := d.expectedSum()
	if err != nil {
		t.Fatalf("expectedSum: %v", err)
	}
	if want != sum(body) {
		t.Errorf("expected hash = %q, want the catalogue pin %q", want, sum(body))
	}
	if !strings.Contains(source, "catalogue") {
		t.Errorf("source = %q, want it to name the catalogue", source)
	}
}

// TestDisagreementRefusesBeforeDownloading is the whole point of having two
// sources. When they differ, one of them is wrong, and downloading gigabytes to
// compare against a hash already known to be disputed is pointless. Preferring
// the pin silently would be worse: it would hide a catalogue that has drifted
// from the file it describes.
func TestDisagreementRefusesBeforeDownloading(t *testing.T) {
	pin := strings.Repeat("a", 64)
	pointer := strings.Repeat("b", 64)
	d := &Download{
		entry: catalog.Entry{SHA256: pin, Display: "Test Model", File: "model.gguf"},
		dir:   t.TempDir(),
	}

	got, _, err := d.crossCheck(pointer)
	if err == nil {
		t.Fatalf("two disagreeing sources were accepted (hash %q)", got)
	}
	// The message has to name both values, or the maintainer cannot tell which
	// side to go and fix.
	for _, want := range []string{"disagree", pin, pointer, "model.gguf"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error does not mention %q:\n%s", want, err)
		}
	}
}

// TestPinIsCaseAndSpaceInsensitive keeps a hand-edited models.ini from failing
// over formatting. An operator pasting an uppercase digest is not a mismatch.
func TestPinIsCaseAndSpaceInsensitive(t *testing.T) {
	lower := strings.Repeat("ab", 32)
	d := &Download{
		entry: catalog.Entry{SHA256: "  " + strings.ToUpper(lower) + "  ", File: "model.gguf"},
		dir:   t.TempDir(),
	}

	got, _, err := d.crossCheck(lower)
	if err != nil {
		t.Fatalf("an uppercase pin was treated as a disagreement: %v", err)
	}
	if got != lower {
		t.Errorf("hash = %q, want normalised %q", got, lower)
	}
}

// TestPointerUsedWhenNoPin is the compatibility path. models.ini has never
// carried the field and the live catalogue publishes null for every entry, so
// the pointer must still verify downloads exactly as it did before.
func TestPointerUsedWhenNoPin(t *testing.T) {
	pointer := strings.Repeat("c", 64)
	d := &Download{entry: catalog.Entry{File: "model.gguf"}, dir: t.TempDir()}

	want, source, err := d.crossCheck(pointer)
	if err != nil {
		t.Fatalf("crossCheck: %v", err)
	}
	if want != pointer {
		t.Errorf("expected hash = %q, want the pointer %q", want, pointer)
	}
	if !strings.Contains(source, "HuggingFace") {
		t.Errorf("source = %q, want it to name HuggingFace", source)
	}
}

// TestPinSurvivesAnUnreachablePointer keeps an upstream outage from silently
// downgrading a pinned download to an unverified one.
func TestPinSurvivesAnUnreachablePointer(t *testing.T) {
	pin := strings.Repeat("d", 64)
	d := &Download{entry: catalog.Entry{SHA256: pin, File: "model.gguf"}, dir: t.TempDir()}

	want, source, err := d.crossCheck("") // pointer unavailable
	if err != nil {
		t.Fatalf("crossCheck: %v", err)
	}
	if want != pin {
		t.Errorf("expected hash = %q, want the pin %q", want, pin)
	}
	if strings.Contains(source, "confirmed") {
		t.Errorf("source %q claims confirmation that did not happen", source)
	}
}

// TestAgreementIsReportedAsConfirmed makes the stronger case legible. When both
// sources agree the download really did clear two independent checks, and the
// message should say so.
func TestAgreementIsReportedAsConfirmed(t *testing.T) {
	pin := strings.Repeat("e", 64)
	d := &Download{entry: catalog.Entry{SHA256: pin, File: "model.gguf"}, dir: t.TempDir()}

	_, source, err := d.crossCheck(pin)
	if err != nil {
		t.Fatalf("crossCheck: %v", err)
	}
	if !strings.Contains(source, "confirmed") {
		t.Errorf("source = %q, want it to record that both sources agreed", source)
	}
}

// TestRequireChecksumRefusesAnUnverifiableDownload covers the new option. With
// no pin and no pointer there is nothing to verify against, and an operator who
// asked for strictness must not get a size check instead.
func TestRequireChecksumRefusesAnUnverifiableDownload(t *testing.T) {
	body := []byte("weights")
	srv := fakeHF(t, body, "") // no pointer served

	e := catalog.Entry{Index: 1, Display: "Test Model", Repo: "owner/repo", File: "model.gguf"}
	dir := t.TempDir()

	d := New(e, dir, RequireChecksum(true))
	d.hostBase = srv.URL
	d.Run()

	st := d.Status()
	if st.State != "error" {
		t.Fatalf("state = %q, want error when nothing can verify the download", st.State)
	}
	if !strings.Contains(st.Message, "require_checksum") {
		t.Errorf("message does not name the setting that caused the refusal:\n%s", st.Message)
	}
	if _, err := os.Stat(filepath.Join(dir, e.File)); !os.IsNotExist(err) {
		t.Error("a refused download left a file behind")
	}
}

// TestRequireChecksumOffKeepsWorking guards the default. Turning the option on
// by default would refuse every download on a stock install, because the
// shipped models.ini carries no hashes.
func TestRequireChecksumOffKeepsWorking(t *testing.T) {
	d := New(catalog.Entry{File: "model.gguf"}, t.TempDir())
	if d.requireChecksum {
		t.Error("require_checksum defaults to on; it must default to off")
	}
}

// TestTamperedDownloadIsRejected is the property all of this exists for. The
// catalogue pins one hash; the host serves different bytes. Nothing may reach
// the models directory.
func TestTamperedDownloadIsRejected(t *testing.T) {
	real := []byte("the weights the catalogue describes")
	swapped := []byte("something else entirely")

	// Only the file is swapped. The pointer still reports the real hash, which
	// is what a compromised or misconfigured CDN edge looks like: metadata that
	// agrees with the catalogue, content that does not.
	srv := fakeHF(t, swapped, sum(real))

	dir := t.TempDir()
	e := testEntry(sum(real))
	d := New(e, dir)
	d.hostBase = srv.URL
	d.sizeFloor = 1
	d.Run()

	st := d.Status()
	if st.State != "error" {
		t.Fatalf("state = %q, want error -- a substituted file was accepted", st.State)
	}
	if !strings.Contains(st.Message, "mismatch") {
		t.Errorf("message does not report a checksum mismatch:\n%s", st.Message)
	}
	if _, err := os.Stat(filepath.Join(dir, e.File)); !os.IsNotExist(err) {
		t.Error("the rejected file was left in the models directory")
	}
	if _, err := os.Stat(filepath.Join(dir, e.File+".part")); !os.IsNotExist(err) {
		t.Error("the partial download was not cleaned up")
	}
}

// TestVerifiedDownloadIsKept is the counterpart. A download whose bytes match
// the pin must land, or the check would be indistinguishable from refusing
// everything.
func TestVerifiedDownloadIsKept(t *testing.T) {
	body := []byte("the weights the catalogue describes")
	srv := fakeHF(t, body, sum(body))

	dir := t.TempDir()
	e := testEntry(sum(body))
	d := New(e, dir, RequireChecksum(true))
	d.hostBase = srv.URL
	d.sizeFloor = 1
	d.Run()

	st := d.Status()
	if st.State != "done" {
		t.Fatalf("state = %q (%s), want done", st.State, st.Message)
	}
	got, err := os.ReadFile(filepath.Join(dir, e.File))
	if err != nil {
		t.Fatalf("verified model not written: %v", err)
	}
	if string(got) != string(body) {
		t.Error("the stored file does not match what was served")
	}
}
