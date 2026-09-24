package state

import (
	"fmt"
	"os"

	"github.com/ElodineOfficial/GobboNet/internal/keyring"
)

// target is a state file and the key it is sealed under, threaded through this
// package in place of the bare path it used to pass around.
//
// The key is nil on an install that is not encrypted, which is most of them and
// stays the default. Every read and write in this package goes through the two
// methods below, so encryption is three decisions in one file rather than a
// condition sprinkled across fifteen handlers.
type target struct {
	path string
	// key is the unlocked keyring, or nil when this install stores plaintext.
	//
	// There is no third state. An unlocked server and a server with live
	// sessions are the same server -- internal/auth's session table is also
	// in-memory and also dies on restart -- so a request that got past the auth
	// gate is a request whose process unwrapped the DEK.
	key *keyring.Keyring
}

// encrypted reports whether writes to this target will be sealed.
func (t target) encrypted() bool { return t.key != nil }

// read returns the document's plaintext bytes.
//
// A plaintext file on an encrypted install is read, not refused. The data is
// intact and perfectly readable, and refusing would manufacture a problem
// rather than surface one -- the next write seals it, and `gobbonet doctor`
// reports the gap in the meantime. This is the path an install takes on the
// first read after encryption is switched on.
func (t target) read() ([]byte, error) {
	raw, err := os.ReadFile(t.path)
	if err != nil {
		return nil, err
	}
	if !keyring.IsSealed(raw) {
		return raw, nil
	}
	if t.key == nil {
		// Never "corrupt", never "empty". Both of those send somebody looking
		// for a backup they do not need.
		return nil, fmt.Errorf("%s is encrypted and this server has not been unlocked", t.path)
	}
	return t.key.Unseal(raw)
}

// write persists the document, sealing it when the install is encrypted.
func (t target) write(body []byte) error {
	if t.key != nil {
		sealed, err := t.key.Seal(body)
		if err != nil {
			return err
		}
		return writeAtomic(t.path, sealed)
	}
	// Without a key, refuse to write over something sealed. This is the one
	// guard that matters: a downgrade here would replace an encrypted history
	// with a plaintext one and answer "ok", which is the exact shape of the
	// bug that unknown /state subpaths used to have.
	if existing, err := os.ReadFile(t.path); err == nil && keyring.IsSealed(existing) {
		return fmt.Errorf("refusing to write plaintext over the encrypted %s -- this server holds no key for it", t.path)
	}
	return writeAtomic(t.path, body)
}
