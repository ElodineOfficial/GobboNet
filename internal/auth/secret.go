package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"golang.org/x/crypto/argon2"
)

// Two secret formats are accepted.
//
// Legacy — "salt:hash", lowercase hex, hash = SHA-256(salt + password). This is
// what launch.bat's :setup_password block wrote and what fileserver.ps1 checked.
// It is a single round of SHA-256, which a consumer GPU brute-forces at billions
// of guesses per second; it exists here only so an existing install keeps
// working across the upgrade.
//
// Current — Argon2id in PHC string format. Memory-hard, so the same GPU buys
// the attacker almost nothing.
//
// A legacy secret that verifies is rewritten as Argon2id on the spot, so users
// migrate by logging in once and never see a forced re-auth.
var legacyRe = regexp.MustCompile(`^([0-9a-fA-F]+):([0-9a-fA-F]+)$`)

// Argon2id parameters. 64 MiB and 3 passes is the draft-RFC "second recommended
// option" — comfortably under a second on the kind of machine that runs a local
// LLM, and expensive to parallelise.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024 // KiB
	argonThreads = 2
	argonKeyLen  = 32
	argonSaltLen = 16
)

// ErrMalformedSecret means the stored secret matches neither format. Callers
// must treat this as "no password configured is impossible, refuse to start"
// rather than "let everyone in".
var ErrMalformedSecret = errors.New("access_secret is neither a legacy salt:hash pair nor an Argon2id hash")

// NewSecret hashes a password for storage.
func NewSecret(password string) (string, error) {
	if len(password) > 1024 {
		return "", errors.New("password exceeds maximum length of 1024 bytes")
	}
	salt := make([]byte, argonSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key := argon2.IDKey([]byte(password), salt, argonTime, argonMemory, argonThreads, argonKeyLen)
	return fmt.Sprintf("$argon2id$v=%d$m=%d,t=%d,p=%d$%s$%s",
		argon2.Version, argonMemory, argonTime, argonThreads,
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// Verify checks password against a stored secret.
//
// needsRehash is true when the secret verified but is in the legacy format, and
// the caller should persist NewSecret(password) to complete the migration.
func Verify(secret, password string) (ok bool, needsRehash bool, err error) {
	if len(password) > 1024 {
		return false, false, nil
	}
	secret = strings.TrimSpace(secret)
	if secret == "" {
		return false, false, nil
	}

	if strings.HasPrefix(secret, "$argon2id$") {
		ok, err := verifyArgon2(secret, password)
		return ok, false, err
	}

	if m := legacyRe.FindStringSubmatch(secret); m != nil {
		salt, want := strings.ToLower(m[1]), strings.ToLower(m[2])
		sum := sha256.Sum256([]byte(salt + password))
		got := hex.EncodeToString(sum[:])
		// Constant-time even though both sides are hex of a public-length
		// digest: a timing difference here leaks how many leading bytes matched.
		if subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1 {
			return true, true, nil
		}
		return false, false, nil
	}

	return false, false, ErrMalformedSecret
}

func verifyArgon2(secret, password string) (bool, error) {
	// $argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash>
	parts := strings.Split(secret, "$")
	if len(parts) != 6 {
		return false, ErrMalformedSecret
	}

	var version int
	if _, err := fmt.Sscanf(parts[2], "v=%d", &version); err != nil {
		return false, ErrMalformedSecret
	}
	if version != argon2.Version {
		return false, fmt.Errorf("unsupported argon2 version %d", version)
	}

	var memory uint32
	var time uint32
	var threads uint8
	if _, err := fmt.Sscanf(parts[3], "m=%d,t=%d,p=%d", &memory, &time, &threads); err != nil {
		return false, ErrMalformedSecret
	}

	salt, err := base64.RawStdEncoding.DecodeString(parts[4])
	if err != nil || len(salt) == 0 {
		return false, ErrMalformedSecret
	}
	want, err := base64.RawStdEncoding.DecodeString(parts[5])
	if err != nil || len(want) < 4 {
		return false, ErrMalformedSecret
	}

	// Derive with the parameters recorded in the hash, not the current
	// constants, so tightening them later doesn't lock existing users out.
	got := argon2.IDKey([]byte(password), salt, time, memory, threads, uint32(len(want)))
	return subtle.ConstantTimeCompare(got, want) == 1, nil
}

// SecretConfigured reports whether a usable password is stored.
func SecretConfigured(secret string) bool {
	secret = strings.TrimSpace(secret)
	return strings.HasPrefix(secret, "$argon2id$") || legacyRe.MatchString(secret)
}
