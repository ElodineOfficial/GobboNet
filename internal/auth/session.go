package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"net"
	"net/http"
	"sync"
	"time"
)

// CookieName is the session cookie. chat.html never reads it (HttpOnly); it
// rides along automatically on the proxy fetches.
const CookieName = "gobbonet_session"

// HeaderName is a fallback for scripted access, where there is no cookie jar.
const HeaderName = "X-Gobbonet-Token"

type session struct {
	expiry   time.Time
	clientID string
}

// SessionStore is the in-memory session table. Sessions do not survive a
// restart, which is the right trade for a single-user home tool: the cost is
// logging in again, and the benefit is that a leaked token has a hard ceiling
// on its lifetime.
type SessionStore struct {
	mu       sync.Mutex
	sessions map[string]session
	ttl      time.Duration
}

func NewSessionStore(ttlHours int) *SessionStore {
	return &SessionStore{
		sessions: make(map[string]session),
		ttl:      time.Duration(ttlHours) * time.Hour,
	}
}

func (s *SessionStore) TTL() time.Duration { return s.ttl }

// Create mints a token bound to a client fingerprint.
func (s *SessionStore) Create(clientID string) (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(raw)

	s.mu.Lock()
	defer s.mu.Unlock()
	s.sessions[token] = session{expiry: time.Now().Add(s.ttl), clientID: clientID}
	s.sweepLocked()
	return token, nil
}

// Validate reports whether the token is live and still bound to this client.
func (s *SessionStore) Validate(token, clientID string) bool {
	if token == "" {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	sess, ok := s.sessions[token]
	if !ok {
		return false
	}
	if time.Now().After(sess.expiry) {
		delete(s.sessions, token)
		return false
	}
	return subtle.ConstantTimeCompare([]byte(sess.clientID), []byte(clientID)) == 1
}

func (s *SessionStore) Revoke(token string) {
	if token == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, token)
}

// sweepLocked drops expired entries. Called on create, which is rare enough to
// keep the table from growing without needing a background goroutine.
func (s *SessionStore) sweepLocked() {
	now := time.Now()
	for token, sess := range s.sessions {
		if now.After(sess.expiry) {
			delete(s.sessions, token)
		}
	}
}

// ClientFingerprint is a coarse identity for the requesting client: source IP
// plus User-Agent, hashed.
//
// Not a strong identity — an on-path attacker can spoof both — but it means a
// cookie sniffed off the plaintext LAN cannot simply be replayed from a
// different device without also matching these. Cheap extra bar.
func ClientFingerprint(r *http.Request) string {
	ip := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip = host
	}
	sum := sha256.Sum256([]byte(ip + "|" + r.Header.Get("User-Agent")))
	return hex.EncodeToString(sum[:])
}

// TokenFromRequest pulls the session token from the cookie, falling back to the
// header for curl and scripts.
func TokenFromRequest(r *http.Request) string {
	if c, err := r.Cookie(CookieName); err == nil && c.Value != "" {
		return c.Value
	}
	return r.Header.Get(HeaderName)
}

// SetSessionCookie issues the session cookie.
//
// No Secure flag: traffic is plain HTTP on the LAN, and Secure would stop the
// cookie being sent at all. The compensating controls are the short TTL, the
// client fingerprint, and SameSite=Lax — which keeps a cross-site form post or
// image load from riding the session, the gap that CORS "*" does not close.
func SetSessionCookie(w http.ResponseWriter, token string, ttl time.Duration) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(ttl.Seconds()),
	})
}

// ClearSessionCookie expires the cookie on logout.
func ClearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     CookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}
