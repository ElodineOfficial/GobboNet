package state

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/keyring"
)

// testKey is what the helpers in state_test.go and patch_test.go hand to
// Handle. It is nil for every test in this package except the ones below, so
// the whole existing suite goes on asserting the plaintext behaviour that every
// install today depends on.
var testKey *keyring.Keyring

// storedBytes is what the server would read back out of the file: the document
// itself, whether or not it went to disk inside an envelope. Tests that assert
// on stored bytes go through here so they assert the same thing either way.
func storedBytes(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := target{path: path, key: testKey}.read()
	if err != nil {
		t.Fatalf("reading stored state at %s: %v", path, err)
	}
	return raw
}

func unlockedKeyring(t *testing.T) *keyring.Keyring {
	t.Helper()
	k, _, err := keyring.Create(filepath.Join(t.TempDir(), "state.keyring"), "password")
	if err != nil {
		t.Fatalf("keyring.Create: %v", err)
	}
	return k
}

// Encryption is meant to be invisible above the file. The strongest statement
// of that is to run the routes' own suite again with a key in place: if any
// conditional request, precondition, etag, append or profile behaves even
// slightly differently sealed, one of these fails.
func TestEveryRouteBehavesTheSameSealed(t *testing.T) {
	testKey = unlockedKeyring(t)
	t.Cleanup(func() { testKey = nil })

	for name, fn := range map[string]func(*testing.T){
		"UnknownSubpathIsNotTheWholeDocument":         TestUnknownSubpathIsNotTheWholeDocument,
		"KnownRoutesStillAnswer":                      TestKnownRoutesStillAnswer,
		"IndexReportsVersionsAndCounts":               TestIndexReportsVersionsAndCounts,
		"IndexCountsUnaddressableThreads":             TestIndexCountsUnaddressableThreads,
		"PatchingOneThreadLeavesEverythingElseIntact": TestPatchingOneThreadLeavesEverythingElseIntact,
		"PatchingPreservesNumericAndTextLiterals":     TestPatchingPreservesNumericAndTextLiterals,
		"MutationsRequireAPrecondition":               TestMutationsRequireAPrecondition,
		"StaleVersionIsRefusedWithTheCurrentOne":      TestStaleVersionIsRefusedWithTheCurrentOne,
		"ReplayedAppendIsRefused":                     TestReplayedAppendIsRefused,
		"AppendRefusesWildcardPrecondition":           TestAppendRefusesWildcardPrecondition,
		"CreateAndReplaceThread":                      TestCreateAndReplaceThread,
		"PutRefusesIdMismatch":                        TestPutRefusesIdMismatch,
		"DeleteThread":                                TestDeleteThread,
		"AppendRejectsNonArrayAndEmptyBodies":         TestAppendRejectsNonArrayAndEmptyBodies,
		"AppendDoesNotCreate":                         TestAppendDoesNotCreate,
		"MetaExcludesThreadsBothWays":                 TestMetaExcludesThreadsBothWays,
		"ConcurrentAppendsToDifferentThreadsAllLand":  TestConcurrentAppendsToDifferentThreadsAllLand,
		"ThreadRoutesHonourProfiles":                  TestThreadRoutesHonourProfiles,
	} {
		t.Run(name, fn)
	}
}

// What lands on disk must be an envelope, and must not be the history.
func TestSealedFileOnDiskIsOpaque(t *testing.T) {
	testKey = unlockedKeyring(t)
	t.Cleanup(func() { testKey = nil })

	sp := statePath(t)
	body := `{"schemaVersion":1,"threads":[{"id":"alpha","title":"gardening","messages":[]}]}`
	if rec := call(t, sp, http.MethodPost, "/state", body); rec.Code != http.StatusOK {
		t.Fatalf("POST /state = %d, want 200", rec.Code)
	}

	raw, err := os.ReadFile(sp)
	if err != nil {
		t.Fatal(err)
	}
	if !keyring.IsSealed(raw) {
		t.Fatalf("state file on disk is not sealed: %s", raw)
	}
	for _, leak := range []string{"alpha", "gardening", "schemaVersion", "threads"} {
		if strings.Contains(string(raw), leak) {
			t.Errorf("sealed state file leaks %q", leak)
		}
	}
	// It is still JSON, so nothing that opens the data directory sees garbage.
	if !json.Valid(raw) {
		t.Error("sealed state file is not valid JSON")
	}

	// And it comes back whole.
	rec := call(t, sp, http.MethodGet, "/state", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /state = %d, want 200", rec.Code)
	}
	if rec.Body.String() != body {
		t.Errorf("GET /state returned\n %s\nwant %s", rec.Body.String(), body)
	}
}

// Turning encryption on does not strand what is already there: a plaintext file
// is read as it stands, and the next write seals it. Refusing would manufacture
// a problem rather than surface one -- the data is intact and readable.
func TestPlaintextIsAdoptedAndSealedOnNextWrite(t *testing.T) {
	sp := statePath(t)
	testKey = nil
	if rec := call(t, sp, http.MethodPost, "/state", `{"threads":[{"id":"old","messages":[]}]}`); rec.Code != http.StatusOK {
		t.Fatalf("seeding plaintext: %d", rec.Code)
	}
	if raw, _ := os.ReadFile(sp); keyring.IsSealed(raw) {
		t.Fatal("test seeded a sealed file")
	}

	testKey = unlockedKeyring(t)
	t.Cleanup(func() { testKey = nil })

	// Readable as it stands.
	rec := call(t, sp, http.MethodGet, "/state/index", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /state/index over a plaintext file = %d, want 200", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), `"old"`) {
		t.Errorf("index did not find the existing conversation: %s", rec.Body.String())
	}

	// And the next write seals it, with the old conversation still inside.
	// The meta route demands a precondition like every other mutation, which
	// is exactly what it should do whether or not the file is encrypted.
	current := call(t, sp, http.MethodGet, "/state/meta", "").Header().Get("ETag")
	if current == "" {
		t.Fatal("GET /state/meta returned no ETag")
	}
	req := httptest.NewRequest(http.MethodPut, "/state/meta", strings.NewReader(`{"schemaVersion":1}`))
	req.Header.Set("If-Match", current)
	rec = httptest.NewRecorder()
	Handle(rec, req, sp, testKey)
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT /state/meta = %d (%s)", rec.Code, rec.Body.String())
	}
	raw, _ := os.ReadFile(sp)
	if !keyring.IsSealed(raw) {
		t.Fatal("the write after unlocking did not seal the file")
	}
	rec = call(t, sp, http.MethodGet, "/state/index", "")
	if !strings.Contains(rec.Body.String(), `"old"`) {
		t.Errorf("sealing lost the existing conversation: %s", rec.Body.String())
	}
}

// The downgrade that must never happen quietly: a server with no key must not
// replace an encrypted history with a plaintext one and answer "ok".
func TestPlaintextWriteOverASealedFileIsRefused(t *testing.T) {
	sp := statePath(t)
	testKey = unlockedKeyring(t)
	if rec := call(t, sp, http.MethodPost, "/state", `{"threads":[{"id":"kept","messages":[]}]}`); rec.Code != http.StatusOK {
		t.Fatalf("seeding sealed: %d", rec.Code)
	}
	sealed, _ := os.ReadFile(sp)

	testKey = nil
	rec := call(t, sp, http.MethodPost, "/state", `{"threads":[]}`)
	if rec.Code == http.StatusOK {
		t.Fatal("a keyless server overwrote an encrypted state file and reported success")
	}
	after, _ := os.ReadFile(sp)
	if string(after) != string(sealed) {
		t.Error("the encrypted state file was modified by a keyless server")
	}
}

// A locked file is not a missing file and not a corrupt one. Saying so is the
// difference between "log in" and an evening spent looking for a backup.
func TestReadingSealedWithoutAKeySaysSo(t *testing.T) {
	sp := statePath(t)
	testKey = unlockedKeyring(t)
	call(t, sp, http.MethodPost, "/state", `{"threads":[{"id":"a","messages":[]}]}`)

	testKey = nil
	rec := call(t, sp, http.MethodGet, "/state", "")
	if rec.Code == http.StatusOK {
		t.Fatal("a keyless server served an encrypted state file")
	}
	if !strings.Contains(rec.Body.String(), "unlocked") {
		t.Errorf("error does not explain the file is locked: %s", rec.Body.String())
	}
}

// Every profile on an install shares the one keyring.
func TestProfilesAreSealedToo(t *testing.T) {
	testKey = unlockedKeyring(t)
	t.Cleanup(func() { testKey = nil })

	sp := statePath(t)
	if rec := call(t, sp, http.MethodPost, "/state?profile=phone", `{"threads":[{"id":"p","messages":[]}]}`); rec.Code != http.StatusOK {
		t.Fatalf("POST profile = %d", rec.Code)
	}
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(sp), "state-phone.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !keyring.IsSealed(raw) {
		t.Error("a profile state file was written in plaintext")
	}
}
