// Package keyring holds the key that encrypts the state files, and the ways in.
//
// # One key, several doors
//
// There is exactly one data encryption key -- the DEK -- a random 256-bit value
// that never leaves this process in the clear and is never derived from
// anything a person types. Each credential gets a keyslot: Argon2id stretches
// the credential into a wrapping key, and that wrapping key seals a copy of the
// DEK.
//
// This is the LUKS arrangement, and the reason for it is the arithmetic.
// Changing a password means resealing one copy of a 32-byte key: a kilobyte
// written, whatever the history weighs. Re-deriving the DEK from the password
// instead would mean re-encrypting every conversation on every password change,
// which is minutes of disk for a change that is conceptually a kilobyte.
//
// It follows that revoking a credential does not touch the data. Rewriting both
// slots kills the old password and the old phrase and costs one small write.
// Rotating the DEK itself would require rewriting the whole store, and only
// buys anything if the DEK leaked -- which takes reading the memory of a
// running server, at which point the attacker already had the plaintext.
//
// # The keyslot is the password verifier
//
// There is no separate hash of the password anywhere once encryption is on.
// Verifying a password means attempting to unwrap its keyslot: if the AEAD tag
// checks, the password was right.
//
// That is not a shortcut, it is the point. The config file stays plaintext so
// the server can start unattended, so any verifier stored there would be an
// offline-crackable copy of the answer sitting next to the question -- an
// attacker with the data directory would grind the cheaper verifier and never
// touch Argon2id at all. One secret deserves exactly one verifier, at full
// memory-hard cost.
//
// # Lifetime
//
// The DEK lives in memory from the login that unwrapped it until the process
// exits. That matches the session table in internal/auth, which is also
// in-memory and also dies on restart -- so an unlocked server and a server with
// live sessions are the same server, and there is no third state where somebody
// holds a valid session against a store nobody has opened.
package keyring

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/chacha20poly1305"

	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
)

// FileVersion is the keyring format. A file claiming a higher number is from a
// newer GobboNet and is refused rather than guessed at.
const FileVersion = 1

// Argon2id parameters, matching internal/auth so a login costs what it always
// cost. 64 MiB and three passes is the draft-RFC second recommended option.
const (
	argonTime    = 3
	argonMemory  = 64 * 1024 // KiB
	argonThreads = 2
	wrapKeyLen   = chacha20poly1305.KeySize
	saltLen      = 16
	dekLen       = 32
)

// SlotKind labels what a slot is opened with. It is not a security boundary --
// a slot is opened by whatever unwraps it -- it exists so a login tries one
// slot instead of every slot, and so `keyring list` can say what the ways in
// are without being able to say what they contain.
type SlotKind string

const (
	SlotPassword SlotKind = "password"
	SlotRecovery SlotKind = "recovery"
)

// ErrNoKeyring means there is no keyring at that path: encryption is off.
var ErrNoKeyring = errors.New("no keyring here -- this install is not encrypted")

// ErrWrongCredential means the credential did not unwrap the slot. Deliberately
// one error for both "wrong password" and "no such slot": telling them apart
// tells an attacker which half to work on.
var ErrWrongCredential = errors.New("that did not unlock the keyring")

// ErrKeyringExists guards `init` against silently replacing a keyring, which
// would strand every state file encrypted under the DEK it just discarded.
var ErrKeyringExists = errors.New("a keyring already exists here")

type kdfParams struct {
	Alg     string `json:"alg"`
	Memory  uint32 `json:"m"`
	Time    uint32 `json:"t"`
	Threads uint8  `json:"p"`
	Salt    string `json:"salt"`
}

type slot struct {
	Kind    SlotKind  `json:"kind"`
	KDF     kdfParams `json:"kdf"`
	Nonce   string    `json:"nonce"`
	Wrapped string    `json:"wrapped"`
}

// file is the on-disk keyring. Everything in it is public: salts, parameters,
// and a sealed DEK. It is still written 0600, because there is no reason to
// hand an attacker the thing they would have to grind.
type file struct {
	Version int    `json:"gobbonet_keyring"`
	DEKID   string `json:"dek_id"`
	Slots   []slot `json:"slots"`
}

// Keyring is an unlocked keyring. Holding one means holding the DEK.
type Keyring struct {
	path string
	dek  []byte
	f    *file
}

// Info is what can be said about a keyring without opening it.
type Info struct {
	Version int
	DEKID   string
	Kinds   []SlotKind
}

// dekID is a short public name for a DEK, so a state file can say which key it
// was sealed under and a mismatch can be reported as a mismatch instead of as
// corruption. A truncated hash of a 256-bit random value gives away nothing.
func dekID(dek []byte) string {
	sum := sha256.Sum256(append([]byte("gobbonet-dek-id\x00"), dek...))
	return hex.EncodeToString(sum[:8])
}

func b64(b []byte) string { return base64.RawStdEncoding.EncodeToString(b) }

func unb64(s string) ([]byte, error) { return base64.RawStdEncoding.DecodeString(s) }

// newSlot seals the DEK under a credential.
func newSlot(kind SlotKind, secret, dek []byte) (slot, error) {
	salt := make([]byte, saltLen)
	if _, err := rand.Read(salt); err != nil {
		return slot{}, err
	}
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	if _, err := rand.Read(nonce); err != nil {
		return slot{}, err
	}

	wrapKey := argon2.IDKey(secret, salt, argonTime, argonMemory, argonThreads, wrapKeyLen)
	aead, err := chacha20poly1305.NewX(wrapKey)
	if err != nil {
		return slot{}, err
	}

	return slot{
		Kind: kind,
		KDF: kdfParams{
			Alg:     "argon2id",
			Memory:  argonMemory,
			Time:    argonTime,
			Threads: argonThreads,
			Salt:    b64(salt),
		},
		Nonce:   b64(nonce),
		Wrapped: b64(aead.Seal(nil, nonce, dek, slotAAD(kind))),
	}, nil
}

// slotAAD binds a sealed DEK to the kind of slot it sits in, so a recovery slot
// cannot be relabelled as a password slot by editing the JSON.
func slotAAD(kind SlotKind) []byte {
	return []byte("gobbonet-keyslot-v1|" + string(kind))
}

// unwrap attempts one slot. The Argon2id call is the expensive part and is why
// callers say which kind they are trying.
func (s slot) unwrap(secret []byte) ([]byte, error) {
	if s.KDF.Alg != "argon2id" {
		return nil, fmt.Errorf("keyslot uses unknown KDF %q", s.KDF.Alg)
	}
	salt, err := unb64(s.KDF.Salt)
	if err != nil {
		return nil, fmt.Errorf("keyslot salt is not valid base64: %w", err)
	}
	nonce, err := unb64(s.Nonce)
	if err != nil {
		return nil, fmt.Errorf("keyslot nonce is not valid base64: %w", err)
	}
	wrapped, err := unb64(s.Wrapped)
	if err != nil {
		return nil, fmt.Errorf("keyslot payload is not valid base64: %w", err)
	}

	// Bound file-supplied work and validate lengths before crypto calls, which
	// otherwise panic on malformed parameters/nonces or allocate arbitrary RAM.
	if s.KDF.Time < 1 || s.KDF.Time > 10 || s.KDF.Memory < 8*uint32(s.KDF.Threads) || s.KDF.Memory > 256*1024 || s.KDF.Threads < 1 || s.KDF.Threads > 16 {
		return nil, errors.New("keyslot KDF parameters are outside supported bounds")
	}
	if len(salt) != saltLen || len(nonce) != chacha20poly1305.NonceSizeX || len(wrapped) != dekLen+chacha20poly1305.Overhead {
		return nil, errors.New("keyslot salt, nonce or payload has an invalid length")
	}

	wrapKey := argon2.IDKey(secret, salt, s.KDF.Time, s.KDF.Memory, s.KDF.Threads, wrapKeyLen)
	aead, err := chacha20poly1305.NewX(wrapKey)
	if err != nil {
		return nil, err
	}
	dek, err := aead.Open(nil, nonce, wrapped, slotAAD(s.Kind))
	if err != nil {
		return nil, ErrWrongCredential
	}
	return dek, nil
}

// Exists reports whether an install is encrypted.
func Exists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// read parses the keyring without unlocking it.
func read(path string) (*file, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ErrNoKeyring
		}
		return nil, err
	}
	var f file
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("keyring at %s is not readable JSON: %w", path, err)
	}
	if f.Version == 0 {
		return nil, fmt.Errorf("%s does not look like a GobboNet keyring", path)
	}
	if f.Version > FileVersion {
		return nil, fmt.Errorf("keyring at %s is version %d, and this GobboNet understands %d -- upgrade rather than let an older build rewrite it", path, f.Version, FileVersion)
	}
	if len(f.Slots) == 0 {
		return nil, fmt.Errorf("keyring at %s has no keyslots, so there is no way into the data it protects", path)
	}
	return &f, nil
}

// Describe reports what the keyring is without needing a credential.
func Describe(path string) (Info, error) {
	f, err := read(path)
	if err != nil {
		return Info{}, err
	}
	kinds := make([]SlotKind, 0, len(f.Slots))
	for _, s := range f.Slots {
		kinds = append(kinds, s.Kind)
	}
	return Info{Version: f.Version, DEKID: f.DEKID, Kinds: kinds}, nil
}

// Create mints a new DEK and seals it under a password and a fresh recovery
// phrase. The phrase is returned exactly once: only its keyslot is stored, so
// nothing afterwards -- no command, no amount of filesystem access -- can print
// it again.
func Create(path, password string) (*Keyring, Phrase, error) {
	if Exists(path) {
		return nil, Phrase{}, ErrKeyringExists
	}
	if password == "" {
		return nil, Phrase{}, errors.New("refusing to create a keyring with an empty password")
	}

	dek := make([]byte, dekLen)
	if _, err := rand.Read(dek); err != nil {
		return nil, Phrase{}, fmt.Errorf("could not read random bytes for a data key: %w", err)
	}
	phrase, err := NewPhrase()
	if err != nil {
		return nil, Phrase{}, err
	}

	pwSlot, err := newSlot(SlotPassword, []byte(password), dek)
	if err != nil {
		return nil, Phrase{}, err
	}
	rcSlot, err := newSlot(SlotRecovery, phrase.Secret(), dek)
	if err != nil {
		return nil, Phrase{}, err
	}

	k := &Keyring{
		path: path,
		dek:  dek,
		f: &file{
			Version: FileVersion,
			DEKID:   dekID(dek),
			Slots:   []slot{pwSlot, rcSlot},
		},
	}
	if err := k.save(); err != nil {
		return nil, Phrase{}, err
	}
	return k, phrase, nil
}

// Unlock opens the keyring with a credential of the given kind.
func Unlock(path string, kind SlotKind, secret []byte) (*Keyring, error) {
	f, err := read(path)
	if err != nil {
		return nil, err
	}
	for _, s := range f.Slots {
		if s.Kind != kind {
			continue
		}
		dek, err := s.unwrap(secret)
		if err != nil {
			// A malformed slot is worth reporting; a wrong credential is not.
			if !errors.Is(err, ErrWrongCredential) {
				return nil, err
			}
			continue
		}
		if len(dek) != dekLen {
			return nil, fmt.Errorf("keyslot yielded a %d-byte key, want %d", len(dek), dekLen)
		}
		if id := dekID(dek); id != f.DEKID {
			return nil, fmt.Errorf("keyslot yielded key %s but the keyring names %s -- this file has been edited", id, f.DEKID)
		}
		return &Keyring{path: path, dek: dek, f: f}, nil
	}
	return nil, ErrWrongCredential
}

// UnlockPassword is the login path.
func UnlockPassword(path, password string) (*Keyring, error) {
	return Unlock(path, SlotPassword, []byte(password))
}

// UnlockPhrase is the recovery path.
func UnlockPhrase(path string, p Phrase) (*Keyring, error) {
	return Unlock(path, SlotRecovery, p.Secret())
}

// DEKID names the key this keyring holds.
func (k *Keyring) DEKID() string { return k.f.DEKID }

// Path is where the keyring lives.
func (k *Keyring) Path() string { return k.path }

// Kinds lists the ways in.
func (k *Keyring) Kinds() []SlotKind {
	out := make([]SlotKind, 0, len(k.f.Slots))
	for _, s := range k.f.Slots {
		out = append(out, s.Kind)
	}
	return out
}

// replaceSlot reseals the DEK under a new credential, replacing any existing
// slot of that kind. The old credential stops working the moment this lands.
func (k *Keyring) replaceSlot(kind SlotKind, secret []byte) error {
	fresh, err := newSlot(kind, secret, k.dek)
	if err != nil {
		return err
	}
	kept := make([]slot, 0, len(k.f.Slots)+1)
	for _, s := range k.f.Slots {
		if s.Kind != kind {
			kept = append(kept, s)
		}
	}
	kept = append(kept, fresh)
	k.f.Slots = kept
	return k.save()
}

// SetPassword rewrites the password slot. Requires an unlocked keyring, because
// a DEK you cannot unwrap is a DEK you cannot reseal -- which is why changing
// the password starts needing the old one the day encryption is turned on.
func (k *Keyring) SetPassword(password string) error {
	if password == "" {
		return errors.New("refusing to set an empty password")
	}
	return k.replaceSlot(SlotPassword, []byte(password))
}

// SetRecovery mints a fresh phrase and rewrites the recovery slot, invalidating
// the previous phrase.
func (k *Keyring) SetRecovery() (Phrase, error) {
	p, err := NewPhrase()
	if err != nil {
		return Phrase{}, err
	}
	if err := k.replaceSlot(SlotRecovery, p.Secret()); err != nil {
		return Phrase{}, err
	}
	return p, nil
}

func (k *Keyring) save() error {
	body, err := json.MarshalIndent(k.f, "", "  ")
	if err != nil {
		return err
	}
	return atomicfile.Write(k.path, append(body, '\n'), 0o600)
}
