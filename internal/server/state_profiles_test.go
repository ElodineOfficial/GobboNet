// Conformance tests for sync profiles — the mechanism behind "make sharing
// between phone and computer optional".
//
// The reason a phone and a desktop shared one history was never a design
// decision. It was that there was exactly one file. Profiles put a second file
// beside it, which makes two things load-bearing that were not before:
//
//   - The default must not move. Every install in the field, and every client
//     written before profiles existed, sends /state with no query string. If
//     that stopped landing on state.json, every existing user would boot into
//     an empty chat with their history still on disk.
//
//   - A profile name becomes part of a filename. That makes the name an
//     untrusted string on a path, so the allowlist is a security boundary and
//     not a formatting preference.
//
// These run through the real server so the routing is covered too. That is
// where the /state/info regression lived: the handler was right and the route
// swallowed it.
package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func statePayload(tag string) string {
	return `{"threads":[{"id":"` + tag + `"}],"settings":{}}`
}

// decodeProfiles pulls the /state/profiles list into something assertable.
func decodeProfiles(t *testing.T, body []byte) []map[string]any {
	t.Helper()
	var out struct {
		Profiles []map[string]any `json:"profiles"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("profiles response is not JSON: %v\nbody: %s", err, body)
	}
	return out.Profiles
}

// The whole point: two devices, two histories, one server.
func TestStateProfilesAreSeparateFiles(t *testing.T) {
	srv, cfg := newTestServer(t)

	if rec := do(t, srv, http.MethodPost, "/state", strings.NewReader(statePayload("desktop"))); rec.Code != http.StatusOK {
		t.Fatalf("store shared: got %d, want 200", rec.Code)
	}
	if rec := do(t, srv, http.MethodPost, "/state?profile=phone", strings.NewReader(statePayload("phone"))); rec.Code != http.StatusOK {
		t.Fatalf("store phone: got %d, want 200", rec.Code)
	}

	// Each read must come back with its own snapshot, not the other's.
	rec := do(t, srv, http.MethodGet, "/state", nil)
	if got := rec.Body.String(); !strings.Contains(got, `"desktop"`) {
		t.Errorf("shared read: got %q, want the desktop snapshot", got)
	}
	rec = do(t, srv, http.MethodGet, "/state?profile=phone", nil)
	if got := rec.Body.String(); !strings.Contains(got, `"phone"`) {
		t.Errorf("phone read: got %q, want the phone snapshot", got)
	}

	// And they are genuinely two files on disk, not one file with a flag.
	if _, err := os.Stat(cfg.StatePath()); err != nil {
		t.Errorf("shared state file missing: %v", err)
	}
	sibling := filepath.Join(filepath.Dir(cfg.StatePath()), "state-phone.json")
	if _, err := os.Stat(sibling); err != nil {
		t.Errorf("profile state file missing: %v", err)
	}

	// Writing one must not disturb the other. This is the assertion that would
	// fail if profiles were ever collapsed back onto a single path.
	if rec := do(t, srv, http.MethodPost, "/state?profile=phone", strings.NewReader(statePayload("phone2"))); rec.Code != http.StatusOK {
		t.Fatalf("rewrite phone: got %d, want 200", rec.Code)
	}
	rec = do(t, srv, http.MethodGet, "/state", nil)
	if got := rec.Body.String(); !strings.Contains(got, `"desktop"`) {
		t.Errorf("shared read after a profile write: got %q, want the desktop snapshot untouched", got)
	}
}

// An install that predates profiles sends no query string, forever.
func TestStateDefaultPathUnchanged(t *testing.T) {
	srv, cfg := newTestServer(t)

	do(t, srv, http.MethodPost, "/state", strings.NewReader(statePayload("legacy")))

	// The bytes must land in exactly the file every existing install already
	// has, under exactly its existing name.
	body, err := os.ReadFile(cfg.StatePath())
	if err != nil {
		t.Fatalf("state.json not written at the documented path: %v", err)
	}
	if !strings.Contains(string(body), `"legacy"`) {
		t.Errorf("state.json contents: got %q", body)
	}

	// An empty profile parameter is the same as no parameter, so a client that
	// builds its URL by string concatenation cannot accidentally fork the file.
	rec := do(t, srv, http.MethodGet, "/state?profile=", nil)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"legacy"`) {
		t.Errorf("empty profile: got %d %q, want the shared snapshot", rec.Code, rec.Body.String())
	}
	entries, _ := os.ReadDir(cfg.DataDir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "state-") {
			t.Errorf("an empty profile created a sibling file: %s", e.Name())
		}
	}
}

// A profile name is an untrusted string that becomes a filename.
func TestStateProfileNameIsAnAllowlist(t *testing.T) {
	srv, cfg := newTestServer(t)

	// Every one of these must be refused outright. Falling back to the shared
	// file would write one device's history into the slot the user separated,
	// which is the single unrecoverable outcome in this feature.
	bad := []string{
		"../../etc/passwd",
		"..",
		".",
		"../state",
		"a/b",
		`a\b`,
		"has space",
		"UPPER CASE AND SPACES",
		"dot.name",
		"-leading-dash",
		"_leading_underscore",
		"tilde~",
		"semi;colon",
		"null\x00byte",
		"quote'name",
		strings.Repeat("x", 33),
		"emoji\u2728",
	}
	for _, name := range bad {
		target := "/state?profile=" + urlQueryEscape(name)
		rec := do(t, srv, http.MethodPost, target, strings.NewReader(statePayload("evil")))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST profile %q: got %d, want 400", name, rec.Code)
		}
		rec = do(t, srv, http.MethodGet, "/state/info?profile="+urlQueryEscape(name), nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("GET info profile %q: got %d, want 400", name, rec.Code)
		}
	}

	// Nothing may have been written anywhere as a side effect.
	if _, err := os.Stat(cfg.StatePath()); err == nil {
		t.Error("a rejected profile still wrote the shared state file")
	}
	entries, _ := os.ReadDir(cfg.DataDir)
	for _, e := range entries {
		if strings.Contains(e.Name(), "state") {
			t.Errorf("a rejected profile left a file behind: %s", e.Name())
		}
	}
	// And nothing escaped the data directory.
	if _, err := os.Stat(filepath.Join(filepath.Dir(cfg.DataDir), "state.json")); err == nil {
		t.Error("a rejected profile wrote outside the data directory")
	}

	good := []string{"phone", "a", "0", "my-phone", "my_phone", "phone2", strings.Repeat("x", 32)}
	for _, name := range good {
		rec := do(t, srv, http.MethodPost, "/state?profile="+name, strings.NewReader(statePayload(name)))
		if rec.Code != http.StatusOK {
			t.Errorf("POST profile %q: got %d, want 200", name, rec.Code)
		}
	}

	// Case folds, so one name cannot become two profiles on Linux and one on
	// Windows -- which would look like data loss the first time a backup moved
	// between machines.
	do(t, srv, http.MethodPost, "/state?profile=Phone", strings.NewReader(statePayload("upper")))
	rec := do(t, srv, http.MethodGet, "/state?profile=phone", nil)
	if !strings.Contains(rec.Body.String(), `"upper"`) {
		t.Errorf("Phone and phone are not the same profile: got %q", rec.Body.String())
	}
}

func TestStateProfilesListing(t *testing.T) {
	srv, _ := newTestServer(t)

	// Nothing stored yet: an empty list, not a 404. A first boot should not
	// look like a broken server.
	rec := do(t, srv, http.MethodGet, "/state/profiles", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("empty listing: got %d, want 200", rec.Code)
	}
	if got := decodeProfiles(t, rec.Body.Bytes()); len(got) != 0 {
		t.Errorf("empty listing: got %v, want []", got)
	}

	do(t, srv, http.MethodPost, "/state", strings.NewReader(statePayload("desktop")))
	do(t, srv, http.MethodPost, "/state?profile=phone", strings.NewReader(statePayload("phone")))
	do(t, srv, http.MethodPost, "/state?profile=tablet", strings.NewReader(statePayload("tablet")))

	rec = do(t, srv, http.MethodGet, "/state/profiles", nil)
	got := decodeProfiles(t, rec.Body.Bytes())
	if len(got) != 3 {
		t.Fatalf("listing: got %d entries, want 3: %v", len(got), got)
	}

	// The shared file comes first and is identified by a flag, not by being
	// called "shared" -- a user may legitimately name a profile that.
	if got[0]["shared"] != true || got[0]["name"] != "" {
		t.Errorf("first entry: got %v, want the shared file with an empty name", got[0])
	}
	if got[1]["name"] != "phone" || got[2]["name"] != "tablet" {
		t.Errorf("profile order: got %v and %v, want phone then tablet", got[1]["name"], got[2]["name"])
	}
	for _, p := range got {
		if size, ok := p["size"].(float64); !ok || size <= 0 {
			t.Errorf("entry %v: size should be a positive number", p)
		}
		if mt, ok := p["mtime"].(float64); !ok || mt <= 0 {
			t.Errorf("entry %v: mtime should be a positive number", p)
		}
	}

	// A user naming a profile "shared" must not become indistinguishable from
	// the shared file.
	do(t, srv, http.MethodPost, "/state?profile=shared", strings.NewReader(statePayload("named-shared")))
	got = decodeProfiles(t, do(t, srv, http.MethodGet, "/state/profiles", nil).Body.Bytes())
	sharedRows := 0
	for _, p := range got {
		if p["shared"] == true {
			sharedRows++
		}
	}
	if sharedRows != 1 {
		t.Errorf("got %d rows flagged shared, want exactly 1: %v", sharedRows, got)
	}
}

// Unrelated files in the data directory must not be reported as profiles.
func TestStateProfilesListingIgnoresOtherFiles(t *testing.T) {
	srv, cfg := newTestServer(t)

	do(t, srv, http.MethodPost, "/state?profile=phone", strings.NewReader(statePayload("phone")))
	for _, name := range []string{
		"llama-server.log", "config.toml", "state-.json", "state-bad name.json",
		"state-UPPER.json", "notstate-phone.json", "state-phone.json.bak",
	} {
		if err := os.WriteFile(filepath.Join(cfg.DataDir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	got := decodeProfiles(t, do(t, srv, http.MethodGet, "/state/profiles", nil).Body.Bytes())
	if len(got) != 1 || got[0]["name"] != "phone" {
		t.Errorf("listing: got %v, want only the phone profile", got)
	}
}

func TestStateProfileDelete(t *testing.T) {
	srv, cfg := newTestServer(t)

	do(t, srv, http.MethodPost, "/state", strings.NewReader(statePayload("desktop")))
	do(t, srv, http.MethodPost, "/state?profile=phone", strings.NewReader(statePayload("phone")))

	rec := do(t, srv, http.MethodDelete, "/state?profile=phone", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete: got %d, want 200", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "state-phone.json")); !os.IsNotExist(err) {
		t.Error("the profile file is still on disk after a delete")
	}
	// Deleting one profile must not touch another.
	if rec := do(t, srv, http.MethodGet, "/state", nil); !strings.Contains(rec.Body.String(), `"desktop"`) {
		t.Error("deleting a profile disturbed the shared file")
	}

	// Deleting something already gone is a success: the caller asked for it to
	// be absent, and it is. A 404 would make the UI report a failure for an
	// outcome the user got.
	if rec := do(t, srv, http.MethodDelete, "/state?profile=phone", nil); rec.Code != http.StatusOK {
		t.Errorf("delete of a missing profile: got %d, want 200", rec.Code)
	}
	if rec := do(t, srv, http.MethodDelete, "/state?profile=..%2Fetc", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("delete with a bad profile name: got %d, want 400", rec.Code)
	}
}

// /state/profiles is a read. Anything else has to be refused rather than
// falling through to the write branch, which is the shape of the original
// /state/info regression.
func TestStateProfilesRejectsWrites(t *testing.T) {
	srv, cfg := newTestServer(t)
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		rec := do(t, srv, method, "/state/profiles", strings.NewReader(`{}`))
		if rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s /state/profiles: got %d, want 405", method, rec.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "profiles")); err == nil {
		t.Error("/state/profiles was treated as a profile name")
	}
}

// Per-profile metadata, since the client's conflict check reads it per target.
func TestStateInfoIsPerProfile(t *testing.T) {
	srv, _ := newTestServer(t)

	do(t, srv, http.MethodPost, "/state", strings.NewReader(statePayload("desktop")))

	// The shared file exists; the phone profile does not. The 404 envelope has
	// to match the one the boot check already knows how to read.
	rec := do(t, srv, http.MethodGet, "/state/info?profile=phone", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("info for an unused profile: got %d, want 404", rec.Code)
	}
	if got := decode(t, rec)["error"]; got != "no state on server" {
		t.Errorf("404 envelope: got %q, want \"no state on server\"", got)
	}

	big := `{"threads":[{"id":"phone","pad":"` + strings.Repeat("x", 500) + `"}]}`
	do(t, srv, http.MethodPost, "/state?profile=phone", strings.NewReader(big))

	sharedInfo := decode(t, do(t, srv, http.MethodGet, "/state/info", nil))
	phoneInfo := decode(t, do(t, srv, http.MethodGet, "/state/info?profile=phone", nil))
	if sharedInfo["size"] == phoneInfo["size"] {
		t.Errorf("info is not per-profile: both report size %v", sharedInfo["size"])
	}
	if got := phoneInfo["size"].(float64); int(got) != len(big) {
		t.Errorf("phone size: got %v, want %d", got, len(big))
	}
}

// A body that does not parse must be refused on a profile exactly as it is on
// the shared file — the validation cannot be something only the default path
// gets.
func TestStateProfileRejectsBadJSON(t *testing.T) {
	srv, cfg := newTestServer(t)
	rec := do(t, srv, http.MethodPost, "/state?profile=phone", strings.NewReader("not json at all"))
	if rec.Code != http.StatusBadRequest {
		t.Errorf("bad JSON to a profile: got %d, want 400", rec.Code)
	}
	if _, err := os.Stat(filepath.Join(cfg.DataDir, "state-phone.json")); err == nil {
		t.Error("an invalid body was persisted to the profile file")
	}
}

// urlQueryEscape is enough for the hostile names above; net/url would also
// reject some of them before the server ever saw them, which is not what is
// under test here.
func urlQueryEscape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '~':
			b.WriteByte(c)
		default:
			b.WriteString(fmt.Sprintf("%%%02X", c))
		}
	}
	return b.String()
}
