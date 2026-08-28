package auth

import (
	"fmt"
	"net/http"
	"testing"
)

// A fresh limiter must allow the first request from an IP.
func TestLimiterAllowsFirstRequest(t *testing.T) {
	limiter := NewLoginLimiter()
	req, _ := http.NewRequest("POST", "/login", nil)
	req.RemoteAddr = "192.168.1.100:12345"

	if !limiter.Allow(req) {
		t.Error("fresh limiter blocked the first request")
	}
}

// The limiter must drain after 'burst' requests and block subsequent ones,
// protecting against brute force.
func TestLimiterDrainsAndBlocks(t *testing.T) {
	limiter := NewLoginLimiter()
	req, _ := http.NewRequest("POST", "/login", nil)
	req.RemoteAddr = "10.0.0.5:54321"

	// default burst is 10
	for i := 0; i < 10; i++ {
		if !limiter.Allow(req) {
			t.Fatalf("limiter blocked request %d, should allow up to 10", i+1)
		}
	}

	if limiter.Allow(req) {
		t.Error("limiter allowed request 11, should have blocked after burst")
	}
}

// Different IPs must get independent buckets so one user fat-fingering their
// password doesn't lock out someone else.
func TestLimiterDifferentIPsIndependent(t *testing.T) {
	limiter := NewLoginLimiter()
	req1, _ := http.NewRequest("POST", "/login", nil)
	req1.RemoteAddr = "1.1.1.1:1111"
	
	req2, _ := http.NewRequest("POST", "/login", nil)
	req2.RemoteAddr = "2.2.2.2:2222"

	for i := 0; i < 10; i++ {
		limiter.Allow(req1)
	}
	
	if limiter.Allow(req1) {
		t.Error("IP 1 should be blocked")
	}
	if !limiter.Allow(req2) {
		t.Error("IP 2 should be allowed despite IP 1 being blocked")
	}
}

// Eviction must bound the internal map size to prevent memory exhaustion
// from a flood of spoofed IPs.
func TestLimiterEviction(t *testing.T) {
	limiter := NewLoginLimiter()
	
	// Fill map past the threshold. The eviction check fires when a new IP
	// arrives and len(buckets) > 4096, so we need 4097 in the map already,
	// then the 4098th triggers the sweep.
	for i := 0; i < 4098; i++ {
		req, _ := http.NewRequest("POST", "/login", nil)
		req.RemoteAddr = fmt.Sprintf("%d.%d.%d.%d:1234", i/16777216%256, i/65536%256, i/256%256, i%256)
		limiter.Allow(req)
	}
	
	limiter.mu.Lock()
	count := len(limiter.buckets)
	limiter.mu.Unlock()
	
	// The 4098th request triggers eviction. All buckets are freshly created, 
	// so none are idle. The hard-cap eviction fallback must fire, reducing to <= 2048
	// (plus the newly inserted bucket).
	if count > 2049 {
		t.Errorf("eviction failed: map size is %d, expected <= 2049", count)
	}
}
