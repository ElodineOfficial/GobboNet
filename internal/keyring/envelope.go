package keyring

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"

	"golang.org/x/crypto/chacha20poly1305"
)

// A sealed state file is a JSON envelope:
//
//	{"gobbonet_envelope":1,"dek_id":"…","nonce":"…","ct":"…"}
//
// JSON rather than raw bytes so the file stays inspectable, keeps its media
// type, and survives every tool in the tree that assumes a state file parses --
// an operator looking at the data directory sees something that says what it is
// instead of a blob that looks like corruption.
//
// The DEK seals the whole document directly. There is no per-file KDF because
// the DEK is already a uniformly random 256-bit key; stretching it again would
// cost a second of CPU per read to add nothing.
//
// XChaCha20-Poly1305 for the 24-byte nonce, which is large enough to generate
// randomly for every write without ever worrying about a repeat.
const EnvelopeVersion = 1

type envelope struct {
	Version int    `json:"gobbonet_envelope"`
	DEKID   string `json:"dek_id"`
	Nonce   string `json:"nonce"`
	CT      string `json:"ct"`
}

// ErrNotSealed means the bytes are not an envelope. Callers decide what that
// means: for a state file on an encrypted install it means a plaintext file is
// sitting where a sealed one belongs, which is worth reporting but is not worth
// refusing to read -- the data is intact and the next write seals it.
var ErrNotSealed = errors.New("not a sealed GobboNet file")

// envelopeMarker is looked for in the first bytes of a file. Our own writer
// emits the version field first, so a genuine envelope always matches here.
var envelopeMarker = []byte(`"gobbonet_envelope"`)

// envelopeSniffBytes is how far in we look. Generously past where the marker
// can actually be, and far short of parsing a multi-megabyte history twice.
const envelopeSniffBytes = 512

// IsSealed reports whether these bytes are an envelope.
func IsSealed(b []byte) bool {
	head := b
	if len(head) > envelopeSniffBytes {
		head = head[:envelopeSniffBytes]
	}
	if !bytes.Contains(head, envelopeMarker) {
		return false
	}
	var e envelope
	return json.Unmarshal(b, &e) == nil && e.Version > 0
}

// Seal encrypts a state document.
func (k *Keyring) Seal(plaintext []byte) ([]byte, error) {
	aead, err := chacha20poly1305.NewX(k.dek)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, chacha20poly1305.NonceSizeX)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("could not read a nonce: %w", err)
	}

	e := envelope{
		Version: EnvelopeVersion,
		DEKID:   k.f.DEKID,
		Nonce:   b64(nonce),
		CT:      b64(aead.Seal(nil, nonce, plaintext, envelopeAAD(k.f.DEKID))),
	}
	body, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	return append(body, '\n'), nil
}

// Unseal decrypts a state document.
func (k *Keyring) Unseal(sealed []byte) ([]byte, error) {
	var e envelope
	if err := json.Unmarshal(sealed, &e); err != nil || e.Version == 0 {
		return nil, ErrNotSealed
	}
	if e.Version > EnvelopeVersion {
		return nil, fmt.Errorf("this file is envelope version %d and this GobboNet understands %d -- upgrade rather than risk writing over it", e.Version, EnvelopeVersion)
	}
	// Named before the tag check, because "sealed under a key you do not have"
	// and "corrupt" are different problems with different answers, and an AEAD
	// failure alone cannot tell them apart.
	if e.DEKID != "" && e.DEKID != k.f.DEKID {
		return nil, fmt.Errorf("this file was sealed under data key %s, and the keyring holds %s -- it belongs to a different GobboNet install, or the keyring was replaced", e.DEKID, k.f.DEKID)
	}

	nonce, err := unb64(e.Nonce)
	if err != nil {
		return nil, fmt.Errorf("envelope nonce is not valid base64: %w", err)
	}
	if len(nonce) != chacha20poly1305.NonceSizeX {
		return nil, errors.New("envelope nonce has an invalid length")
	}
	ct, err := unb64(e.CT)
	if err != nil {
		return nil, fmt.Errorf("envelope ciphertext is not valid base64: %w", err)
	}

	aead, err := chacha20poly1305.NewX(k.dek)
	if err != nil {
		return nil, err
	}
	plaintext, err := aead.Open(nil, nonce, ct, envelopeAAD(e.DEKID))
	if err != nil {
		return nil, errors.New("this file did not survive its integrity check -- it has been altered or truncated since it was written")
	}
	return plaintext, nil
}

// envelopeAAD binds the ciphertext to the key it claims to be sealed under, so
// the dek_id cannot be edited to point at another install's file.
func envelopeAAD(id string) []byte {
	return []byte("gobbonet-envelope-v1|" + id)
}
