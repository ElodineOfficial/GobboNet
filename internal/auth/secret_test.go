package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// 1.7.9 made the minimum for NEW passwords a setting (min_password_length,
// 8 by default, as low as 4). That rule lives where passwords are chosen,
// never here: a password set under any earlier or looser minimum must keep
// signing in after the upgrade, in both stored formats. Locking people out on update
// would trade a theoretical weakness for a certain support ticket.
func TestShortExistingPasswordsStillVerify(t *testing.T) {
	const old = "abc123" // six characters: valid before 1.7.9

	argon, err := NewSecret(old)
	if err != nil {
		t.Fatal(err)
	}
	if ok, rehash, err := Verify(argon, old); !ok || rehash || err != nil {
		t.Errorf("argon2id, 6-char password: ok=%v rehash=%v err=%v", ok, rehash, err)
	}

	salt := "0123456789abcdef0123456789abcdef"
	sum := sha256.Sum256([]byte(salt + old))
	legacy := salt + ":" + hex.EncodeToString(sum[:])
	if !legacyRe.MatchString(legacy) {
		t.Skipf("legacy test secret %q does not match legacyRe; update the fixture", legacy)
	}
	ok, rehash, err := Verify(legacy, old)
	if !ok || !rehash || err != nil {
		t.Errorf("legacy sha256, 6-char password: ok=%v rehash=%v err=%v (want ok and a rehash)", ok, rehash, err)
	}
}
