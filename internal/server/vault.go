package server

import (
	"errors"
	"log"
	"net/http"

	"github.com/ElodineOfficial/GobboNet/internal/auth"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/keyring"
)

// encrypted reports whether this install stores its history sealed. The keyring
// on disk is the only thing that says so -- no config flag, because a flag can
// disagree with the files and the files are what has to be read.
func (s *Server) encrypted() bool {
	return keyring.Exists(s.cfg.KeyringPath())
}

func (s *Server) currentVault() *keyring.Keyring {
	s.vaultMu.RLock()
	defer s.vaultMu.RUnlock()
	return s.vault
}

func (s *Server) setVault(k *keyring.Keyring) {
	s.vaultMu.Lock()
	defer s.vaultMu.Unlock()
	s.vault = k
}

// checkPassword verifies a login and, on an encrypted install, unlocks the
// store as it does so.
//
// The two branches are genuinely different verifiers, not a preference:
//
// Plaintext install -- the Argon2id hash in the config file, exactly as it has
// always worked, including the one-login upgrade from the legacy SHA-256 pair.
//
// Encrypted install -- the password keyslot. There is deliberately no hash in
// the config any more, because config stays plaintext so the server can start
// unattended, and a verifier kept there would be an offline-crackable copy of
// the answer sitting next to the question. Unwrapping the slot proves the
// password at full memory-hard cost and hands back the key in the same breath.
func (s *Server) checkPassword(password string) (ok bool, err error) {
	if !s.encrypted() {
		s.secretMu.RLock()
		secret := s.secret
		s.secretMu.RUnlock()

		ok, needsRehash, err := auth.Verify(secret, password)
		if err != nil {
			log.Printf("[auth] stored secret is unusable: %v", err)
		}
		if ok && needsRehash {
			s.upgradeSecret(password)
		}
		return ok, err
	}

	k, err := keyring.UnlockPassword(s.cfg.KeyringPath(), password)
	if err != nil {
		if errors.Is(err, keyring.ErrWrongCredential) {
			return false, nil
		}
		// A keyring that cannot be read at all is not a wrong password, and
		// must not be reported as one -- that sends somebody to try harder at
		// typing when the file is the problem.
		log.Printf("[keyring] %s is unusable: %v", s.cfg.KeyringPath(), err)
		return false, err
	}
	s.setVault(k)
	log.Printf("[keyring] state unlocked (data key %s)", k.DEKID())
	return true, nil
}

// stateVault returns the key to hand the state package, or answers the request
// itself if this install is encrypted and nothing has opened it.
//
// In practice the second case cannot arise from a restart, because a restart
// takes the sessions with it. It can arise from `gobbonet keyring init` being
// run in another terminal while the server is up, and the honest answer to that
// is the same as to any expired session: log in again.
func (s *Server) stateVault(w http.ResponseWriter, r *http.Request) (*keyring.Keyring, bool) {
	if !s.encrypted() {
		return nil, true
	}
	if k := s.currentVault(); k != nil {
		return k, true
	}
	httpx.WriteJSON(w, r, http.StatusUnauthorized, map[string]string{
		"error": "this history is encrypted and the server has not been unlocked since it started -- sign in again",
		"login": "/login",
	})
	return nil, false
}
