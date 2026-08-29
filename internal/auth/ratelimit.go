package auth

import (
	"net"
	"net/http"
	"sync"
	"time"
)

// LoginLimiter is a per-IP token bucket on POST /login.
//
// Constant-time comparison protects against learning the password one byte at a
// time; it does nothing about someone simply trying a lot of passwords. A
// bucket of 10 with a 6-second refill lets a person who fat-fingered their
// password retry immediately, while capping a script at ten guesses a minute —
// which turns even a short password from minutes of work into years.
type LoginLimiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket

	burst  float64
	refill float64 // tokens per second
}

type bucket struct {
	tokens float64
	last   time.Time
}

func NewLoginLimiter() *LoginLimiter {
	return &LoginLimiter{
		buckets: make(map[string]*bucket),
		burst:   10,
		refill:  1.0 / 6.0,
	}
}

// Allow consumes a token for the request's source IP.
func (l *LoginLimiter) Allow(r *http.Request) bool {
	ip := r.RemoteAddr
	if host, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		ip = host
	}

	now := time.Now()

	l.mu.Lock()
	defer l.mu.Unlock()

	b, ok := l.buckets[ip]
	if !ok {
		// Bound the table so a flood from spoofed or churning source addresses
		// can't grow it without limit. A bucket idle long enough has refilled
		// to burst, so forgetting it is equivalent to keeping it.
		if len(l.buckets) > 4096 {
			idle := time.Duration(l.burst/l.refill) * time.Second
			for k, v := range l.buckets {
				if v.tokens >= l.burst || now.Sub(v.last) >= idle {
					delete(l.buckets, k)
				}
			}
			if len(l.buckets) > 4096 {
				for k := range l.buckets {
					delete(l.buckets, k)
					if len(l.buckets) <= 2048 {
						break
					}
				}
			}
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[ip] = b
	}

	elapsed := now.Sub(b.last).Seconds()
	b.last = now
	b.tokens += elapsed * l.refill
	if b.tokens > l.burst {
		b.tokens = l.burst
	}

	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}
