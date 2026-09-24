package keyring

import (
	"bytes"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

const sampleState = `{"schemaVersion":1,"threads":[{"id":"alpha","title":"tea","messages":[{"role":"user","content":"hello"}]}]}`

func TestSealRoundTrip(t *testing.T) {
	k, _, _ := newKeyring(t, "password")

	sealed, err := k.Seal([]byte(sampleState))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}
	plain, err := k.Unseal(sealed)
	if err != nil {
		t.Fatalf("Unseal: %v", err)
	}
	if string(plain) != sampleState {
		t.Errorf("round trip changed the document:\n got %s\nwant %s", plain, sampleState)
	}
}

// The file must still look like a GobboNet file to anything that opens the data
// directory, and must not contain what it is protecting.
func TestSealedFileIsInspectableJSONAndOpaque(t *testing.T) {
	k, _, _ := newKeyring(t, "password")
	sealed, err := k.Seal([]byte(sampleState))
	if err != nil {
		t.Fatal(err)
	}

	if !json.Valid(sealed) {
		t.Error("a sealed state file is not valid JSON")
	}
	if !IsSealed(sealed) {
		t.Error("IsSealed does not recognise our own envelope")
	}
	for _, leak := range []string{"alpha", "tea", "hello", "schemaVersion"} {
		if bytes.Contains(sealed, []byte(leak)) {
			t.Errorf("sealed file contains plaintext %q", leak)
		}
	}

	var e envelope
	if err := json.Unmarshal(sealed, &e); err != nil {
		t.Fatalf("envelope does not parse: %v", err)
	}
	if e.Version != EnvelopeVersion {
		t.Errorf("Version = %d, want %d", e.Version, EnvelopeVersion)
	}
	if e.DEKID != k.DEKID() {
		t.Errorf("dek_id = %q, want %q", e.DEKID, k.DEKID())
	}
}

func TestEveryWriteUsesAFreshNonce(t *testing.T) {
	k, _, _ := newKeyring(t, "password")
	seen := make(map[string]bool, 100)
	for i := 0; i < 100; i++ {
		sealed, err := k.Seal([]byte(sampleState))
		if err != nil {
			t.Fatal(err)
		}
		var e envelope
		if err := json.Unmarshal(sealed, &e); err != nil {
			t.Fatal(err)
		}
		if seen[e.Nonce] {
			t.Fatalf("nonce %q reused on write %d", e.Nonce, i)
		}
		seen[e.Nonce] = true
	}
}

func TestPlaintextIsNotMistakenForAnEnvelope(t *testing.T) {
	if IsSealed([]byte(sampleState)) {
		t.Error("a plain state document was taken for an envelope")
	}
	k, _, _ := newKeyring(t, "password")
	if _, err := k.Unseal([]byte(sampleState)); !errors.Is(err, ErrNotSealed) {
		t.Errorf("Unseal(plaintext) err = %v, want ErrNotSealed", err)
	}
	if IsSealed([]byte("not json at all")) {
		t.Error("garbage was taken for an envelope")
	}
}

// Tampering must be reported as tampering, not decoded into something.
func TestAlteredCiphertextIsRefused(t *testing.T) {
	k, _, _ := newKeyring(t, "password")
	sealed, _ := k.Seal([]byte(sampleState))

	var e envelope
	if err := json.Unmarshal(sealed, &e); err != nil {
		t.Fatal(err)
	}
	ct, err := unb64(e.CT)
	if err != nil {
		t.Fatal(err)
	}
	ct[len(ct)/2] ^= 0x01
	e.CT = b64(ct)
	altered, _ := json.Marshal(e)

	_, err = k.Unseal(altered)
	if err == nil {
		t.Fatal("altered ciphertext was accepted")
	}
	if !strings.Contains(err.Error(), "integrity") {
		t.Errorf("err = %v, want it to name the integrity check", err)
	}
}

// A file from another install is a different problem from a corrupt file, and
// the AEAD tag alone cannot tell the user which one they have.
func TestFileFromAnotherInstallIsNamedAsSuch(t *testing.T) {
	mine, _, _ := newKeyring(t, "password")

	otherPath := filepath.Join(t.TempDir(), "other.keyring")
	theirs, _, err := Create(otherPath, "their password")
	if err != nil {
		t.Fatal(err)
	}
	theirFile, err := theirs.Seal([]byte(sampleState))
	if err != nil {
		t.Fatal(err)
	}

	_, err = mine.Unseal(theirFile)
	if err == nil {
		t.Fatal("another install's file was accepted")
	}
	if !strings.Contains(err.Error(), theirs.DEKID()) || !strings.Contains(err.Error(), mine.DEKID()) {
		t.Errorf("err = %v, want it to name both data keys", err)
	}
}

// Editing dek_id to match must not get the file past the AEAD, because the id
// is authenticated too.
func TestSpoofedDEKIDStillFails(t *testing.T) {
	mine, _, _ := newKeyring(t, "password")
	otherPath := filepath.Join(t.TempDir(), "other.keyring")
	theirs, _, _ := Create(otherPath, "their password")
	theirFile, _ := theirs.Seal([]byte(sampleState))

	var e envelope
	if err := json.Unmarshal(theirFile, &e); err != nil {
		t.Fatal(err)
	}
	e.DEKID = mine.DEKID()
	spoofed, _ := json.Marshal(e)

	if _, err := mine.Unseal(spoofed); err == nil {
		t.Fatal("a file with a spoofed dek_id was accepted")
	}
}

func TestEnvelopeFromTheFutureIsRefused(t *testing.T) {
	k, _, _ := newKeyring(t, "password")
	sealed, _ := k.Seal([]byte(sampleState))

	var e envelope
	if err := json.Unmarshal(sealed, &e); err != nil {
		t.Fatal(err)
	}
	e.Version = EnvelopeVersion + 1
	future, _ := json.Marshal(e)

	_, err := k.Unseal(future)
	if err == nil {
		t.Fatal("an envelope from the future was accepted")
	}
	if !strings.Contains(err.Error(), "upgrade") {
		t.Errorf("err = %v, want it to say to upgrade", err)
	}
}

func TestEmptyAndLargeDocumentsRoundTrip(t *testing.T) {
	k, _, _ := newKeyring(t, "password")
	big := `{"threads":[` + strings.Repeat(`{"id":"x","messages":[]},`, 20000) + `{"id":"last"}]}`

	for name, doc := range map[string]string{
		"empty object": `{}`,
		"empty bytes":  ``,
		"large":        big,
	} {
		sealed, err := k.Seal([]byte(doc))
		if err != nil {
			t.Fatalf("%s: Seal: %v", name, err)
		}
		plain, err := k.Unseal(sealed)
		if err != nil {
			t.Fatalf("%s: Unseal: %v", name, err)
		}
		if string(plain) != doc {
			t.Errorf("%s: round trip changed the document", name)
		}
	}
}
