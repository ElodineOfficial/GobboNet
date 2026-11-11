package supervisor

import (
	"strings"
	"sync"
)

// ringBuffer keeps the last N bytes written to it.
//
// This replaces the 1.7 PowerShell server's Get-LlamaStartupError, which tailed
// llama-server.log and grepped it with regexes. Capturing the child's stderr
// directly means a failed launch produces a structured, in-memory answer instead
// of a race against a log file that may not have been flushed yet.
type ringBuffer struct {
	mu   sync.Mutex
	buf  []byte
	size int
	full bool
	pos  int
}

func newRingBuffer(size int) *ringBuffer {
	return &ringBuffer{buf: make([]byte, size), size: size}
}

func (r *ringBuffer) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	n := len(p)
	// Only the tail can survive, so a write larger than the ring collapses to
	// its last `size` bytes.
	if n >= r.size {
		copy(r.buf, p[n-r.size:])
		r.pos = 0
		r.full = true
		return n, nil
	}

	end := r.pos + n
	if end <= r.size {
		copy(r.buf[r.pos:], p)
	} else {
		split := r.size - r.pos
		copy(r.buf[r.pos:], p[:split])
		copy(r.buf, p[split:])
		r.full = true
	}
	r.pos = end % r.size
	if end >= r.size {
		r.full = true
	}
	return n, nil
}

// String returns the buffered bytes in write order.
func (r *ringBuffer) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	if !r.full {
		return string(r.buf[:r.pos])
	}
	return string(r.buf[r.pos:]) + string(r.buf[:r.pos])
}

func (r *ringBuffer) Reset() {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.pos = 0
	r.full = false
}

// interestingLines are markers llama.cpp uses for the failures a user can
// actually act on: a bad file, not enough VRAM, an unusable template, a port
// already taken.
var interestingLines = []string{
	"error",
	"failed",
	"cannot",
	"unable to",
	"out of memory",
	"invalid",
	"unsupported",
	"no such file",
	"address already in use",
}

// LastError extracts a human-readable failure reason from the captured stderr:
// the line that shows a known cause (cause.go) if there is one, else the
// latest line holding a marker -- skipping llama.cpp's sign-off ("exiting due
// to model loading error"), which says only that it failed and used to win
// every time (1.8.0, #67), unless nothing else was said at all.
//
// Returns "" when nothing in the buffer looks like a diagnosis, so the caller
// can fall back to a generic message rather than show the user an arbitrary
// slice of startup chatter.
func (r *ringBuffer) LastError() string {
	if f := r.failure(); f != nil {
		return f.Line
	}
	return ""
}

// lastErrorIn is the generic scan: from the end, the first line holding an
// interesting marker that is not a sign-off; failing that, a sign-off.
func lastErrorIn(text string) string {
	if strings.TrimSpace(text) == "" {
		return ""
	}
	lines := strings.Split(text, "\n")
	for _, allowSummary := range []bool{false, true} {
		// Scan from the end: the fatal line is the last thing written before
		// exit, and earlier warnings are usually noise.
		for i := len(lines) - 1; i >= 0; i-- {
			line := strings.TrimSpace(lines[i])
			if line == "" {
				continue
			}
			lower := strings.ToLower(line)
			if !allowSummary && isSummaryLine(lower) {
				continue
			}
			for _, marker := range interestingLines {
				if strings.Contains(lower, marker) {
					return truncate(line, 400)
				}
			}
		}
	}
	return ""
}

// Tail returns the last n non-empty lines, for diagnostics where no single line
// is conclusive.
func (r *ringBuffer) Tail(n int) string {
	lines := strings.Split(r.String(), "\n")
	var kept []string
	for i := len(lines) - 1; i >= 0 && len(kept) < n; i-- {
		if strings.TrimSpace(lines[i]) != "" {
			kept = append([]string{strings.TrimSpace(lines[i])}, kept...)
		}
	}
	return strings.Join(kept, "\n")
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "..."
}
