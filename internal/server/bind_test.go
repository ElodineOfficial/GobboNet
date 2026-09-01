package server

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/jmccardle/gobbonet/internal/config"
)

// bindServer builds the smallest Server that Listen and handleHealth need.
func bindServer(t *testing.T, host string, port int) *Server {
	t.Helper()
	cfg := config.Default()
	cfg.ListenHost = host
	cfg.ListenPort = port
	cfg.DataDir = t.TempDir()
	s, err := New(cfg, config.ModeRemote, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return s
}

// freePort returns a port nothing is listening on.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	return port
}

// TestWideBindIsPreferred is the guard on the security direction of this
// change. A machine that CAN bind the network must still do so; a fallback that
// triggered when it was not needed would quietly take phone access away.
func TestWideBindIsPreferred(t *testing.T) {
	s := bindServer(t, "0.0.0.0", freePort(t))
	b, err := s.Listen()
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer b.Listener.Close()

	if b.FellBack {
		t.Error("fell back to loopback despite the wide bind being available")
	}
	if !b.LANReachable() {
		t.Error("wide bind reported as not LAN reachable")
	}
	if b.Host != "0.0.0.0" {
		t.Errorf("bound host = %q, want 0.0.0.0", b.Host)
	}
}

// TestConfiguredLoopbackIsNotAFallback distinguishes "asked to stay local" from
// "was forced to stay local". Both bind 127.0.0.1; only one is a warning, and
// the banner prints a scary line for the wrong one if they are conflated.
func TestConfiguredLoopbackIsNotAFallback(t *testing.T) {
	s := bindServer(t, "127.0.0.1", freePort(t))
	b, err := s.Listen()
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer b.Listener.Close()

	if b.FellBack {
		t.Error("a configured loopback bind was reported as a fallback")
	}
	if b.LANReachable() {
		t.Error("loopback reported as LAN reachable")
	}
}

// TestBothBindsDeniedReportsTheWideError covers a privileged port, where the
// fallback cannot help: port 1 needs root on loopback too, so both attempts
// fail.
//
// What matters is WHICH error comes back. The loopback attempt is diagnosis,
// not the user's configuration — reporting its failure would describe an
// address they never asked for. The wide error is the one that names what they
// set, so that is the one returned.
//
// Skipped as root, where the bind succeeds and there is no denial to observe.
func TestBothBindsDeniedReportsTheWideError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: a privileged bind succeeds, so there is no denial to test")
	}
	s := bindServer(t, "0.0.0.0", 1)
	b, err := s.Listen()
	if err == nil {
		b.Listener.Close()
		t.Fatal("bind succeeded on port 1 as an unprivileged user")
	}
	if !errors.Is(err, syscall.EACCES) {
		t.Errorf("error = %v, want EACCES", err)
	}
	// The wide address, not the loopback one the fallback tried.
	if !strings.Contains(err.Error(), "0.0.0.0:1") {
		t.Errorf("error names %q; want the configured 0.0.0.0:1", err.Error())
	}
	if strings.Contains(err.Error(), "127.0.0.1") {
		t.Errorf("error reports the diagnostic loopback attempt: %v", err)
	}
}

// TestFallbackOnUnavailableAddress is the same recovery reached through
// EADDRNOTAVAIL rather than a permission denial, which makes it runnable at any
// privilege level — including as root, where the port-1 test above has nothing
// to prove.
//
// It is also a real configuration: listen_host pinned to a LAN address that
// DHCP later moved. The machine then has no such address, the bind fails, and
// before this change desktop chat went down with it.
func TestFallbackOnUnavailableAddress(t *testing.T) {
	// TEST-NET-1 (RFC 5737). Reserved for documentation, so it is never a real
	// local address on any correctly configured machine.
	s := bindServer(t, "192.0.2.1", freePort(t))
	b, err := s.Listen()
	if err != nil {
		t.Fatalf("Listen returned an error instead of falling back: %v", err)
	}
	defer b.Listener.Close()

	if !b.FellBack {
		t.Fatal("bind succeeded on an address this machine does not have")
	}
	if b.Host != "127.0.0.1" {
		t.Errorf("fallback host = %q, want 127.0.0.1", b.Host)
	}
	conn, err := net.Dial("tcp", b.Listener.Addr().String())
	if err != nil {
		t.Fatalf("fallback listener does not accept connections: %v", err)
	}
	conn.Close()
}

// TestNoFallbackWhenPortIsInUse keeps the fallback out of the way of the
// in-use path. Moving to loopback there would hide "something already holds
// this port", which is the most common startup failure and has its own message.
func TestNoFallbackWhenPortIsInUse(t *testing.T) {
	held, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatalf("hold port: %v", err)
	}
	defer held.Close()
	port := held.Addr().(*net.TCPAddr).Port

	s := bindServer(t, "0.0.0.0", port)
	b, err := s.Listen()
	if err == nil {
		b.Listener.Close()
		t.Fatal("Listen succeeded on a held port; expected an in-use error")
	}
	if !errors.Is(err, syscall.EADDRINUSE) {
		t.Errorf("error = %v, want EADDRINUSE unchanged", err)
	}
}

// TestRecoverableOnLoopback pins the classification. EADDRINUSE belonging to
// the non-recoverable side is the load-bearing case: it is what keeps a busy
// port from being silently answered on a narrower address.
func TestRecoverableOnLoopback(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"EACCES", syscall.EACCES, true},
		{"EADDRNOTAVAIL", syscall.EADDRNOTAVAIL, true},
		{"EAFNOSUPPORT", syscall.EAFNOSUPPORT, true},
		{"EADDRINUSE", syscall.EADDRINUSE, false},
		{"WSAEACCES", syscall.Errno(10013), true},
		{"WSAEAFNOSUPPORT", syscall.Errno(10047), true},
		{"WSAEADDRNOTAVAIL", syscall.Errno(10049), true},
		{"WSAEADDRINUSE", syscall.Errno(10048), false},
		{"unrelated", errors.New("boom"), false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Wrapped the way net.Listen delivers it, so the test exercises
			// the errors.As unwrapping rather than a bare comparison.
			wrapped := &net.OpError{Op: "listen", Err: os.NewSyscallError("bind", tc.err)}
			if got := recoverableOnLoopback(wrapped); got != tc.want {
				t.Errorf("recoverableOnLoopback(%v) = %v, want %v", tc.err, got, tc.want)
			}
		})
	}
}

// TestIsLoopbackHost covers the empty host specifically. net.Listen treats ""
// as the wildcard, so reading it as loopback would mean a server bound to every
// interface reported itself as local-only.
func TestIsLoopbackHost(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":   true,
		"127.0.0.2":   true,
		"::1":         true,
		"localhost":   true,
		"0.0.0.0":     false,
		"::":          false,
		"":            false,
		"192.168.1.5": false,
	}
	for host, want := range cases {
		if got := isLoopbackHost(host); got != want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", host, got, want)
		}
	}
}

// TestLoopbackForKeepsAddressFamily stops an IPv6 configuration from falling
// back onto a socket its clients cannot reach.
func TestLoopbackForKeepsAddressFamily(t *testing.T) {
	if got := loopbackFor("::"); got != "::1" {
		t.Errorf("loopbackFor(::) = %q, want ::1", got)
	}
	if got := loopbackFor("0.0.0.0"); got != "127.0.0.1" {
		t.Errorf("loopbackFor(0.0.0.0) = %q, want 127.0.0.1", got)
	}
}

// TestHealthReportsBind covers the durable half of the report. The banner
// scrolls away; "I can't reach it from my phone" arrives days later, and this
// endpoint is what can still answer it.
func TestHealthReportsBind(t *testing.T) {
	s := bindServer(t, "0.0.0.0", 9066)
	s.SetBind(&Bind{
		Host:     "127.0.0.1",
		Port:     9066,
		FellBack: true,
		WideErr:  errors.New("listen tcp 0.0.0.0:9066: bind: permission denied"),
	})

	rr := httptest.NewRecorder()
	s.handleHealth(rr, httptest.NewRequest(http.MethodGet, "/health-fileserver", nil))

	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health body: %v", err)
	}
	if body["lan_access"] != false {
		t.Errorf("lan_access = %v, want false", body["lan_access"])
	}
	if body["listen_host"] != "127.0.0.1" {
		t.Errorf("listen_host = %v, want 127.0.0.1", body["listen_host"])
	}
	if _, ok := body["lan_bind_denied"]; !ok {
		t.Error("lan_bind_denied missing after a fallback")
	}
}

// TestHealthOmitsBindWhenUnknown keeps the endpoint from guessing. A Server
// with no published bind must not claim LAN access is off.
func TestHealthOmitsBindWhenUnknown(t *testing.T) {
	s := bindServer(t, "0.0.0.0", 9066)

	rr := httptest.NewRecorder()
	s.handleHealth(rr, httptest.NewRequest(http.MethodGet, "/health-fileserver", nil))

	var body map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode health body: %v", err)
	}
	if _, ok := body["lan_access"]; ok {
		t.Error("lan_access reported without a known bind")
	}
	if body["status"] != "ok" {
		t.Errorf("status = %v, want ok", body["status"])
	}
}
