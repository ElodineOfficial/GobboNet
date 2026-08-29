package auth

import (
	"testing"
	"time"
)

// A session created with a client ID must validate for the same client ID.
func TestSessionCreateAndValidate(t *testing.T) {
	store := NewSessionStore(1)
	clientID := "client-fingerprint-123"

	token, err := store.Create(clientID)
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}
	if token == "" {
		t.Fatal("Create returned empty token")
	}

	if !store.Validate(token, clientID) {
		t.Error("Validate rejected a fresh, matching session")
	}
}

// Garbage or unknown tokens must be rejected.
func TestSessionValidateGarbageToken(t *testing.T) {
	store := NewSessionStore(1)
	if store.Validate("garbage-token", "any-client") {
		t.Error("Validate accepted a garbage token")
	}
	if store.Validate("", "any-client") {
		t.Error("Validate accepted an empty token")
	}
}

// Revoke must immediately invalidate a session.
func TestSessionRevoke(t *testing.T) {
	store := NewSessionStore(1)
	clientID := "client-1"
	token, _ := store.Create(clientID)

	store.Revoke(token)
	if store.Validate(token, clientID) {
		t.Error("Validate accepted a revoked token")
	}
}

// Session expiry must prevent validation after the TTL.
func TestSessionExpiry(t *testing.T) {
	// A TTL of 0 hours means sessions expire instantly.
	store := NewSessionStore(0)
	clientID := "client-1"
	token, _ := store.Create(clientID)

	// Sleep slightly just in case time resolution issues occur
	time.Sleep(1 * time.Millisecond)

	if store.Validate(token, clientID) {
		t.Error("Validate accepted an expired session")
	}
}

// Sessions must be bound to the client fingerprint; one device cannot use another's token.
func TestSessionClientFingerprintBinding(t *testing.T) {
	store := NewSessionStore(1)
	token, _ := store.Create("client-A")

	if store.Validate(token, "client-B") {
		t.Error("Validate accepted token for wrong client fingerprint")
	}
}
