package auth

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"
)

// A round trip of NewSecret and Verify guarantees the chosen Argon2id parameters
// actually work and agree with the verifier.
func TestSecretRoundTrip(t *testing.T) {
	pw := "correct-horse-battery-staple"
	secret, err := NewSecret(pw)
	if err != nil {
		t.Fatalf("NewSecret failed: %v", err)
	}
	
	if !strings.HasPrefix(secret, "$argon2id$") {
		t.Errorf("NewSecret must return an argon2id hash, got: %s", secret)
	}

	ok, needsRehash, err := Verify(secret, pw)
	if err != nil {
		t.Fatalf("Verify failed on valid secret: %v", err)
	}
	if !ok {
		t.Error("Verify rejected the correct password")
	}
	if needsRehash {
		t.Error("needsRehash must be false for Argon2id secrets")
	}
}

// Verify must not accept incorrect passwords for a valid Argon2id secret.
func TestVerifyRejectsWrongPassword(t *testing.T) {
	pw := "correct-password"
	secret, _ := NewSecret(pw)
	
	ok, _, err := Verify(secret, "wrong-password")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("Verify accepted the wrong password")
	}
}

// An empty secret must return false (auth failed) without an error, because
// "no password" is a valid state before first setup, not a crashable offense
// during verification.
func TestVerifyHandlesEmptySecret(t *testing.T) {
	ok, needsRehash, err := Verify("", "any-password")
	if err != nil {
		t.Errorf("unexpected error on empty secret: %v", err)
	}
	if ok || needsRehash {
		t.Error("Verify accepted a password against an empty secret")
	}

	ok, needsRehash, err = Verify("   \t   ", "any-password")
	if err != nil {
		t.Errorf("unexpected error on whitespace secret: %v", err)
	}
	if ok || needsRehash {
		t.Error("Verify accepted a password against a whitespace secret")
	}
}

// Existing installs have salt:hash passwords. They must continue to verify
// and signal that they should be upgraded.
func TestVerifyHandlesLegacyFormat(t *testing.T) {
	pw := "legacy-password"
	salt := "deadbeef"
	sum := sha256.Sum256([]byte(salt + pw))
	secret := salt + ":" + hex.EncodeToString(sum[:])

	ok, needsRehash, err := Verify(secret, pw)
	if err != nil {
		t.Fatalf("Verify failed on legacy secret: %v", err)
	}
	if !ok {
		t.Error("Verify rejected the correct legacy password")
	}
	if !needsRehash {
		t.Error("legacy secret must trigger needsRehash to migrate to Argon2id")
	}
	
	ok, _, _ = Verify(secret, "wrong-password")
	if ok {
		t.Error("Verify accepted wrong legacy password")
	}
}

// Hard limits protect the hashing functions from being used as a denial-of-service
// vector by feeding them MBs of text.
func TestPasswordLengthLimits(t *testing.T) {
	longPw := strings.Repeat("A", 1025)
	
	_, err := NewSecret(longPw)
	if err == nil {
		t.Error("NewSecret accepted a password > 1024 bytes")
	}
	
	ok, _, err := Verify("dummy-secret", longPw)
	if err != nil {
		t.Errorf("Verify should not error on long password, got: %v", err)
	}
	if ok {
		t.Error("Verify accepted a password > 1024 bytes")
	}
}

// Malformed secrets from accidental config edits or bad writes must be rejected safely.
func TestVerifyHandlesMalformedSecrets(t *testing.T) {
	cases := []string{
		"not-a-hash",
		"$argon2id$v=19$m=65536,t=3,p=2", // missing parts
		"$argon2id$v=19$m=65536,t=3,p=2$notbase64$notbase64",
		"$argon2id$v=99$m=65536,t=3,p=2$c2FsdA$aGFzaA", // unsupported version
		"deadbeef:not-hex",
	}
	
	for _, tc := range cases {
		ok, _, err := Verify(tc, "password")
		if ok {
			t.Errorf("Verify unexpectedly accepted password for malformed secret: %q", tc)
		}
		// Structural issues return ErrMalformedSecret; unsupported versions
		// return a descriptive error. Either way: not nil, not ok.
		if err == nil {
			t.Errorf("secret %q: Verify returned no error for a malformed secret", tc)
		}
	}
}

// SecretConfigured distinguishes an initialized system from a fresh one.
func TestSecretConfigured(t *testing.T) {
	cases := []struct{
		secret string
		want   bool
	}{
		{"", false},
		{"   ", false},
		{"$argon2id$v=19$...", true},
		{"deadbeef:1234567890abcdef", true},
		{"invalid-format", false},
	}
	for _, tc := range cases {
		if got := SecretConfigured(tc.secret); got != tc.want {
			t.Errorf("SecretConfigured(%q) = %v, want %v", tc.secret, got, tc.want)
		}
	}
}
