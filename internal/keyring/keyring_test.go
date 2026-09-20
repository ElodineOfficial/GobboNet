package keyring

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newKeyring(t *testing.T, password string) (*Keyring, Phrase, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "state.keyring")
	k, phrase, err := Create(path, password)
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	return k, phrase, path
}

func TestCreateMakesTwoWaysIn(t *testing.T) {
	k, phrase, path := newKeyring(t, "correct horse")

	byPassword, err := UnlockPassword(path, "correct horse")
	if err != nil {
		t.Fatalf("UnlockPassword: %v", err)
	}
	byPhrase, err := UnlockPhrase(path, phrase)
	if err != nil {
		t.Fatalf("UnlockPhrase: %v", err)
	}

	// Both doors, one key.
	if !bytes.Equal(byPassword.dek, k.dek) || !bytes.Equal(byPhrase.dek, k.dek) {
		t.Fatal("the two keyslots do not yield the same data key")
	}
	if byPassword.DEKID() != k.DEKID() {
		t.Errorf("DEKID = %q, want %q", byPassword.DEKID(), k.DEKID())
	}
}

func TestWrongCredentialsAreIndistinguishable(t *testing.T) {
	_, phrase, path := newKeyring(t, "correct horse")

	if _, err := UnlockPassword(path, "wrong horse"); !errors.Is(err, ErrWrongCredential) {
		t.Errorf("wrong password: err = %v, want ErrWrongCredential", err)
	}
	// A valid phrase for a different keyring is still just "no".
	other, err := NewPhrase()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := UnlockPhrase(path, other); !errors.Is(err, ErrWrongCredential) {
		t.Errorf("wrong phrase: err = %v, want ErrWrongCredential", err)
	}
	// And a password may not open the recovery slot, nor a phrase the password
	// slot -- the slot kind is authenticated, not decorative.
	if _, err := Unlock(path, SlotRecovery, []byte("correct horse")); !errors.Is(err, ErrWrongCredential) {
		t.Errorf("password against recovery slot: err = %v, want ErrWrongCredential", err)
	}
	if _, err := Unlock(path, SlotPassword, phrase.Secret()); !errors.Is(err, ErrWrongCredential) {
		t.Errorf("phrase against password slot: err = %v, want ErrWrongCredential", err)
	}
}

// The whole reason for wrapping a DEK: a password change must not touch data.
func TestSetPasswordKeepsTheDataKey(t *testing.T) {
	k, phrase, path := newKeyring(t, "old password")
	sealed, err := k.Seal([]byte(`{"threads":[]}`))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	if err := k.SetPassword("new password"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}

	if _, err := UnlockPassword(path, "old password"); !errors.Is(err, ErrWrongCredential) {
		t.Errorf("old password still works: err = %v", err)
	}
	reopened, err := UnlockPassword(path, "new password")
	if err != nil {
		t.Fatalf("UnlockPassword with the new password: %v", err)
	}
	// Data sealed before the change still opens, and the phrase is untouched.
	if _, err := reopened.Unseal(sealed); err != nil {
		t.Errorf("data sealed before the password change no longer opens: %v", err)
	}
	if _, err := UnlockPhrase(path, phrase); err != nil {
		t.Errorf("changing the password invalidated the recovery phrase: %v", err)
	}
}

func TestSetRecoveryInvalidatesTheOldPhrase(t *testing.T) {
	k, oldPhrase, path := newKeyring(t, "password")

	newPhrase, err := k.SetRecovery()
	if err != nil {
		t.Fatalf("SetRecovery: %v", err)
	}
	if newPhrase.String() == oldPhrase.String() {
		t.Fatal("SetRecovery returned the same phrase")
	}
	if _, err := UnlockPhrase(path, oldPhrase); !errors.Is(err, ErrWrongCredential) {
		t.Errorf("the old phrase still works: err = %v", err)
	}
	if _, err := UnlockPhrase(path, newPhrase); err != nil {
		t.Errorf("the new phrase does not work: %v", err)
	}
	if _, err := UnlockPassword(path, "password"); err != nil {
		t.Errorf("rotating the phrase disturbed the password slot: %v", err)
	}
}

// Recovery, end to end: phrase in, both credentials replaced, old ones dead.
func TestRecoverReplacesBothCredentials(t *testing.T) {
	k, phrase, path := newKeyring(t, "forgotten")
	sealed, _ := k.Seal([]byte(`{"threads":[{"id":"a"}]}`))

	recovered, err := UnlockPhrase(path, phrase)
	if err != nil {
		t.Fatalf("UnlockPhrase: %v", err)
	}
	if err := recovered.SetPassword("remembered"); err != nil {
		t.Fatalf("SetPassword: %v", err)
	}
	freshPhrase, err := recovered.SetRecovery()
	if err != nil {
		t.Fatalf("SetRecovery: %v", err)
	}

	for name, check := range map[string]func() error{
		"old password": func() error { _, e := UnlockPassword(path, "forgotten"); return e },
		"old phrase":   func() error { _, e := UnlockPhrase(path, phrase); return e },
	} {
		if err := check(); !errors.Is(err, ErrWrongCredential) {
			t.Errorf("%s still works after recovery: err = %v", name, err)
		}
	}

	final, err := UnlockPassword(path, "remembered")
	if err != nil {
		t.Fatalf("new password does not work: %v", err)
	}
	if _, err := UnlockPhrase(path, freshPhrase); err != nil {
		t.Errorf("new phrase does not work: %v", err)
	}
	// And the history is still the history -- recovery never touched it.
	plain, err := final.Unseal(sealed)
	if err != nil {
		t.Fatalf("Unseal after recovery: %v", err)
	}
	if string(plain) != `{"threads":[{"id":"a"}]}` {
		t.Errorf("data changed through recovery: %s", plain)
	}
}

func TestCreateRefusesToReplaceAKeyring(t *testing.T) {
	_, _, path := newKeyring(t, "password")
	if _, _, err := Create(path, "another"); !errors.Is(err, ErrKeyringExists) {
		t.Fatalf("Create over an existing keyring: err = %v, want ErrKeyringExists", err)
	}
}

func TestCreateRefusesAnEmptyPassword(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.keyring")
	if _, _, err := Create(path, ""); err == nil {
		t.Fatal("Create accepted an empty password")
	}
}

func TestKeyringIsWrittenPrivately(t *testing.T) {
	_, _, path := newKeyring(t, "password")
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("keyring mode = %o, want 600", perm)
	}
}

// Nothing in the file may be the phrase or the password, and the DEK must not
// be sitting there in the clear.
func TestKeyringFileLeaksNothing(t *testing.T) {
	k, phrase, path := newKeyring(t, "hunter2")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(raw)
	for _, secret := range append(phrase.Words(), "hunter2") {
		// Short words genuinely appear in base64 by chance, so only look for
		// them as whole JSON-visible tokens rather than substrings.
		if strings.Contains(body, `"`+secret+`"`) {
			t.Errorf("keyring file contains the secret %q", secret)
		}
	}
	if bytes.Contains(raw, k.dek) {
		t.Error("keyring file contains the raw data key")
	}
	if bytes.Contains(raw, []byte(b64(k.dek))) {
		t.Error("keyring file contains the data key in base64")
	}
}

func TestMissingKeyringIsNamedAsNotEncrypted(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.keyring")
	if Exists(path) {
		t.Fatal("Exists reported a keyring that is not there")
	}
	if _, err := UnlockPassword(path, "anything"); !errors.Is(err, ErrNoKeyring) {
		t.Errorf("err = %v, want ErrNoKeyring", err)
	}
	if _, err := Describe(path); !errors.Is(err, ErrNoKeyring) {
		t.Errorf("Describe err = %v, want ErrNoKeyring", err)
	}
}

func TestKeyringFromTheFutureIsRefused(t *testing.T) {
	_, _, path := newKeyring(t, "password")
	raw, _ := os.ReadFile(path)
	var f map[string]any
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	f["gobbonet_keyring"] = FileVersion + 1
	edited, _ := json.Marshal(f)
	if err := os.WriteFile(path, edited, 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := UnlockPassword(path, "password")
	if err == nil {
		t.Fatal("a keyring from the future was accepted")
	}
	if !strings.Contains(err.Error(), "upgrade") {
		t.Errorf("err = %v, want it to say to upgrade", err)
	}
}

func TestDescribeReportsTheWaysInWithoutOpening(t *testing.T) {
	k, _, path := newKeyring(t, "password")
	info, err := Describe(path)
	if err != nil {
		t.Fatalf("Describe: %v", err)
	}
	if info.DEKID != k.DEKID() {
		t.Errorf("DEKID = %q, want %q", info.DEKID, k.DEKID())
	}
	want := map[SlotKind]bool{SlotPassword: true, SlotRecovery: true}
	if len(info.Kinds) != 2 {
		t.Fatalf("Kinds = %v, want two", info.Kinds)
	}
	for _, kind := range info.Kinds {
		if !want[kind] {
			t.Errorf("unexpected slot kind %q", kind)
		}
	}
}

// An edited slot must not be able to hand back something that is not the DEK.
func TestRelabelledSlotIsRefused(t *testing.T) {
	_, phrase, path := newKeyring(t, "password")
	raw, _ := os.ReadFile(path)
	// Call the recovery slot a password slot. The AAD binds the kind, so this
	// breaks the seal rather than moving the credential.
	edited := bytes.Replace(raw, []byte(`"kind": "recovery"`), []byte(`"kind": "password"`), 1)
	if bytes.Equal(edited, raw) {
		t.Fatal("test did not find the recovery slot to relabel")
	}
	if err := os.WriteFile(path, edited, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Unlock(path, SlotPassword, phrase.Secret()); !errors.Is(err, ErrWrongCredential) {
		t.Errorf("a relabelled slot opened: err = %v", err)
	}
}
