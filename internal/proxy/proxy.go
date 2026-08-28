// Package proxy is the streaming reverse proxy behind /llm/*, /search/* and
// /embed/*. Port of Invoke-Proxy from fileserver.ps1.
//
// The original hand-rolled hop-by-hop header stripping and chunked framing.
// This uses httputil.ReverseProxy instead: the standard library already knows
// the RFC 9110 rules, including the Connection-header-names-more-headers case
// that hand-rolled versions reliably miss.
//
// FlushInterval -1 is the load-bearing setting. Without it, Go buffers the
// response and token-by-token replies arrive in one lump after a long silence.
package proxy

import (
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/jmccardle/gobbonet/internal/httpx"
)

const (
	// dialTimeout is short: either the upstream is there or it isn't.
	dialTimeout = 10 * time.Second

	// responseHeaderTimeout must clear the worst realistic prompt-processing
	// delay. A 40K-context prefill on a large model can run well past thirty
	// seconds before llama.cpp emits its first byte, and cutting that off looks
	// to the user like the server is broken when it is merely busy.
	responseHeaderTimeout = 5 * time.Minute

	// idleTimeout bounds the gap BETWEEN chunks once a stream is flowing, not
	// the total duration. A long generation is healthy and may run for many
	// minutes; ten minutes of complete silence is a wedged upstream.
	idleTimeout = 10 * time.Minute
)

// Proxy forwards a path prefix to an upstream base URL.
type Proxy struct {
	prefix   string
	upstream *url.URL
	apiKey   string
	rp       *httputil.ReverseProxy
}

// New builds a proxy stripping prefix and forwarding to upstreamBase.
//
// apiKey, when set, replaces any client-supplied Authorization header. The
// browser never sees it.
func New(prefix, upstreamBase, apiKey string) (*Proxy, error) {
	target, err := url.Parse(upstreamBase)
	if err != nil {
		return nil, err
	}

	p := &Proxy{prefix: prefix, upstream: target, apiKey: apiKey}

	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: dialTimeout, KeepAlive: 30 * time.Second}).DialContext,
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: responseHeaderTimeout,
		IdleConnTimeout:       90 * time.Second,
		// SSE is uncompressed; asking for gzip would only add work and defeat
		// incremental flushing.
		DisableCompression: true,
		ForceAttemptHTTP2:  false,
	}

	p.rp = &httputil.ReverseProxy{
		Rewrite:       p.rewrite,
		Transport:     transport,
		FlushInterval: -1, // flush every write: this is what makes streaming stream
		ErrorHandler:  p.handleError,
		ModifyResponse: func(resp *http.Response) error {
			// Replace the upstream's CORS headers with ours.
			//
			// Deleting is not enough. ReverseProxy writes the upstream headers
			// straight to the client, so a proxied response never passes through
			// httpx.CommonHeaders the way our own handlers do — strip-only
			// leaves /llm, /search and /embed with no CORS headers at all, while
			// the OPTIONS preflight for those same paths answers "*". A browser
			// that is told the preflight passes and then gets an actual response
			// with no Allow-Origin blocks the result, which is exactly the
			// file:// and cross-origin case the "*" policy exists to support.
			//
			// Set, don't Add: the upstream sends its own copies, and duplicates
			// are rejected outright.
			resp.Header.Set("Access-Control-Allow-Origin", "*")
			resp.Header.Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
			resp.Header.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			// Watchdog on the streaming body. ReverseProxy has no notion of an
			// idle stream, so we wrap the body and cancel the request context
			// if it goes quiet for too long.
			resp.Body = newIdleReader(resp.Body, idleTimeout)
			return nil
		},
	}
	return p, nil
}

// rewrite maps the inbound request onto the upstream.
func (p *Proxy) rewrite(r *httputil.ProxyRequest) {
	path := r.In.URL.Path
	upstreamPath := path
	if strings.HasPrefix(path, p.prefix) {
		upstreamPath = strings.TrimPrefix(path, p.prefix)
		if !strings.HasPrefix(upstreamPath, "/") {
			upstreamPath = "/" + upstreamPath
		}
	}

	r.Out.URL.Scheme = p.upstream.Scheme
	r.Out.URL.Host = p.upstream.Host
	r.Out.URL.Path = strings.TrimSuffix(p.upstream.Path, "/") + upstreamPath
	r.Out.URL.RawQuery = r.In.URL.RawQuery
	r.Out.Host = p.upstream.Host

	// Our session cookie is for THIS server and nothing else. fileserver.ps1
	// forwarded it, which was harmless when every upstream was a loopback port
	// it had spawned itself. Here the upstream may be a remote host, so passing
	// the cookie on would hand our access token to a third machine — and into
	// its logs — for no reason.
	r.Out.Header.Del("Cookie")
	r.Out.Header.Del("X-Gobbonet-Token")

	// Don't advertise the client's chain to the upstream. The upstream is a
	// trusted backend, not a service that needs to know who our users are.
	r.Out.Header.Del("X-Forwarded-For")

	if p.apiKey != "" {
		r.Out.Header.Set("Authorization", "Bearer "+p.apiKey)
	}
}

func (p *Proxy) handleError(w http.ResponseWriter, r *http.Request, err error) {
	// A client that navigated away mid-stream is routine on mobile — it is the
	// exact failure the detached-jobs API exists to work around — and is not
	// worth logging as a server problem.
	if r.Context().Err() != nil {
		return
	}
	log.Printf("[proxy] %s %s -> %v", r.Method, r.URL.Path, err)
	httpx.ErrorDetail(w, r, http.StatusBadGateway, "upstream unreachable", err.Error())
}

func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if p.upstream.Host == "" {
		// An empty upstream URL means the feature is switched off in config.
		// Say so plainly instead of dialing an empty host.
		httpx.Error(w, r, http.StatusBadGateway, "upstream not configured")
		return
	}
	p.rp.ServeHTTP(w, r)
}

// --- Idle watchdog ---------------------------------------------------------

// idleReader cancels the underlying request if no bytes arrive for timeout.
//
// This is the "600-second timeout should be idle, not total" requirement: a
// generation that streams for an hour is fine, a connection that produces
// nothing for ten minutes is not.
type idleReader struct {
	inner   io.ReadCloser
	timer   *time.Timer
	timeout time.Duration

	mu     sync.Mutex
	closed bool
}

func newIdleReader(inner io.ReadCloser, timeout time.Duration) io.ReadCloser {
	ir := &idleReader{inner: inner, timeout: timeout}
	ir.timer = time.AfterFunc(timeout, func() {
		// Closing the body unblocks the in-flight Read with an error, which
		// ReverseProxy surfaces as a truncated response — the honest outcome.
		ir.closeInner()
	})
	return ir
}

func (ir *idleReader) Read(p []byte) (int, error) {
	n, err := ir.inner.Read(p)
	if n > 0 {
		ir.timer.Reset(ir.timeout)
	}
	return n, err
}

func (ir *idleReader) Close() error {
	ir.timer.Stop()
	return ir.closeInner()
}

func (ir *idleReader) closeInner() error {
	ir.mu.Lock()
	defer ir.mu.Unlock()
	if ir.closed {
		return nil
	}
	ir.closed = true
	return ir.inner.Close()
}
