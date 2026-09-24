package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/auth"
	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/keyring"
)

// The marker's job is to be unrecognisable to a build that predates all this.
// auth.SecretConfigured accepts only Argon2id and the legacy salt:hash pair, so
// an older gobbonet reads the marker, calls the secret malformed, and stops --
// instead of serving a history it cannot decrypt, or worse, overwriting it.
//
// If this ever starts passing, that protection is gone silently.
func TestKeyringMarkerIsNotAUsableSecret(t *testing.T) {
	if auth.SecretConfigured(keyringMarker) {
		t.Fatalf("SecretConfigured(%q) = true; an older build would start and serve an encrypted install unguarded", keyringMarker)
	}
	if ok, _, err := auth.Verify(keyringMarker, "anything"); ok {
		t.Fatalf("auth.Verify accepted a password against the marker (err = %v)", err)
	}
}

// And the current build must not trip over its own marker at startup.
func TestEncryptedInstallNeedsNoStoredHash(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{Path: filepath.Join(dir, "config.toml"), DataDir: dir, AccessSecret: keyringMarker}

	// Without a keyring, the marker is exactly the malformed secret it looks
	// like, and startup must refuse.
	if err := ensurePassword(&cfg); err == nil {
		t.Error("ensurePassword accepted the marker with no keyring to back it")
	}

	if _, _, err := keyring.Create(cfg.KeyringPath(), "password"); err != nil {
		t.Fatalf("keyring.Create: %v", err)
	}
	if err := ensurePassword(&cfg); err != nil {
		t.Errorf("ensurePassword on an encrypted install: %v", err)
	}
}

// One keyring covers the shared file and every profile beside it, so the
// commands that seal and unseal have to find all of them -- and nothing else.
func TestStateFilesFindsProfilesAndNothingElse(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{Path: filepath.Join(dir, "config.toml"), DataDir: dir}

	write := func(name string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	for _, n := range []string{
		"state.json", "state-phone.json", "state-work.json",
		"state.keyring",    // the key itself is never a state file
		"llama-server.log", // neighbours in the data dir
		"state.json.bak",   // a hand-made backup is not ours to rewrite
		"notstate.json",    //
	} {
		write(n)
	}
	if err := os.Mkdir(filepath.Join(dir, "state-dir.json"), 0o700); err != nil {
		t.Fatal(err)
	}

	got, err := stateFiles(cfg)
	if err != nil {
		t.Fatalf("stateFiles: %v", err)
	}
	want := map[string]bool{"state.json": true, "state-phone.json": true, "state-work.json": true}
	if len(got) != len(want) {
		t.Fatalf("stateFiles returned %v, want exactly %d files", got, len(want))
	}
	for _, f := range got {
		if !want[filepath.Base(f)] {
			t.Errorf("stateFiles included %s", f)
		}
	}
}

func TestEncryptionResumesWithoutReplacingKeyOrSealedFiles(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Config{Path: filepath.Join(dir, "config.toml"), DataDir: dir}
	if err := os.WriteFile(cfg.Path, []byte("access_secret = \"old\"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	k, phrase, err := keyring.Create(cfg.KeyringPath(), "password")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg.StatePath(), []byte(`{"threads":[]}`), 0600); err != nil {
		t.Fatal(err)
	}
	// A damaged sealed profile fails after state-a has already been sealed.
	a := filepath.Join(dir, "state-a.json")
	z := filepath.Join(dir, "state-z.json")
	os.WriteFile(a, []byte(`{"threads":[]}`), 0600)
	os.WriteFile(z, []byte(`{"gobbonet_envelope":1,"dek_id":"wrong-key"}`), 0600)
	if err := finishEncryption(cfg, k); err == nil {
		t.Fatal("bad profile silently accepted")
	}
	before, _ := os.ReadFile(a)
	if !keyring.IsSealed(before) {
		t.Fatal("fixture did not reach partial encryption")
	}
	os.WriteFile(z, []byte(`{"threads":[]}`), 0600)
	if err := finishEncryption(cfg, k); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(a)
	if string(before) != string(after) {
		t.Fatal("resumption unnecessarily rewrote sealed history")
	}
	for _, path := range []string{a, z, cfg.StatePath()} {
		raw, _ := os.ReadFile(path)
		if _, err := k.Unseal(raw); err != nil {
			t.Fatal(path, err)
		}
	}
	recovered, err := keyring.UnlockPhrase(cfg.KeyringPath(), phrase)
	if err != nil || recovered.DEKID() != k.DEKID() {
		t.Fatal("recovery key changed", err)
	}
}
