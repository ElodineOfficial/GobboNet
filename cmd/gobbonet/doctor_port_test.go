package main

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

// These cover NEW-4: `doctor` reported "in use: no -- the port is free to
// bind" for a port GobboNet was actively listening on.
//
// The old probe asked one question — can I bind this address — and let the
// answer decide everything, including identity. That is the wrong question.
// "Could I bind" and "is my server running" are different, and under WSL2
// mirrored networking they came apart: the guest was not told about the
// conflict, so the bind succeeded and the section that exists to diagnose a
// port conflict reported no conflict.
//
// The probe now asks the server first. An HTTP reply cannot be wrong in the
// direction that matters: if something answers, something is listening.

// fakeGobboNet serves the same /health-fileserver shape the real server does,
// which is what the identity check keys on.
func fakeGobboNet(t *testing.T, status int, body string) (host string, port int) {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/health-fileserver", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		fmt.Fprint(w, body)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	h, p, err := net.SplitHostPort(strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	n, err := strconv.Atoi(p)
	if err != nil {
		t.Fatal(err)
	}
	return h, n
}

func report(t *testing.T, host string, port int) string {
	t.Helper()
	var sb strings.Builder
	reportPortOwner(&sb, host, port)
	return sb.String()
}

// The headline case. A lying bind probe must not be able to hide a running
// server: this is exactly the WSL2 observation, reproduced by forcing the
// bind to report success while a server answers.
func TestPortOwnerTrustsTheAnswerOverTheBind(t *testing.T) {
	host, port := fakeGobboNet(t, 200, `{"status":"ok","mode":"local"}`)

	original := bindProbe
	bindProbe = func(string) error { return nil } // "the port is free"
	t.Cleanup(func() { bindProbe = original })

	out := report(t, host, port)

	if strings.Contains(out, "in use:      no") {
		t.Errorf("reported a live server's port as free:\n%s", out)
	}
	if !strings.Contains(out, "in use:      YES") {
		t.Errorf("did not report the port as in use:\n%s", out)
	}
	if !strings.Contains(out, "already running") {
		t.Errorf("did not identify the listener as GobboNet:\n%s", out)
	}
	// The disagreement is worth surfacing rather than papering over: someone
	// reading this needs to know the bind probe is unreliable on their box.
	if !strings.Contains(out, "bind probe disagreed") {
		t.Errorf("did not note the disagreement:\n%s", out)
	}
}

// The ordinary path, with a real bind conflict and no seam in play.
func TestPortOwnerIdentifiesRunningServer(t *testing.T) {
	host, port := fakeGobboNet(t, 200, `{"status":"ok","mode":"local"}`)

	out := report(t, host, port)
	if !strings.Contains(out, "in use:      YES") {
		t.Errorf("held port reported free:\n%s", out)
	}
	if !strings.Contains(out, "already running") {
		t.Errorf("did not identify GobboNet:\n%s", out)
	}
}

// require_auth defaults to true, so on a normal install the 401 is the thing
// that proves the listener is ours. Mistaking it for a stranger would tell a
// user to move a port their own server is correctly serving on.
func TestPortOwnerIdentifiesRunningServerBehindAuth(t *testing.T) {
	host, port := fakeGobboNet(t, 401, `{"login":"/login"}`)

	out := report(t, host, port)
	if !strings.Contains(out, "already running") {
		t.Errorf("401 from our own auth not recognised as GobboNet:\n%s", out)
	}
}

// A stranger on the port must still be called out, or the check has traded one
// wrong answer for another.
func TestPortOwnerReportsStranger(t *testing.T) {
	host, port := fakeGobboNet(t, 200, `<html>Some other web server</html>`)

	out := report(t, host, port)
	if !strings.Contains(out, "NOT GobboNet") {
		t.Errorf("a stranger was not called out:\n%s", out)
	}
	if !strings.Contains(out, "listen_port") {
		t.Errorf("no remedy offered:\n%s", out)
	}
}

// Something holding the port that does not speak HTTP at all: a bare TCP
// listener. The bind probe is the only thing that can see this, which is what
// it is still good for.
func TestPortOwnerReportsNonHTTPHolder(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()

	_, p, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(p)

	out := report(t, "127.0.0.1", port)
	if !strings.Contains(out, "in use:      YES") {
		t.Errorf("occupied port reported free:\n%s", out)
	}
	if !strings.Contains(out, "did not answer HTTP") {
		t.Errorf("non-HTTP holder not described:\n%s", out)
	}
}

// A genuinely free port still reads as free. The fix must not make everything
// look occupied.
func TestPortOwnerReportsFreePort(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	_, p, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(p)
	ln.Close() // now nobody holds it

	out := report(t, "127.0.0.1", port)
	if !strings.Contains(out, "in use:      no") {
		t.Errorf("free port not reported free:\n%s", out)
	}
	if strings.Contains(out, "identity:") {
		t.Errorf("identified an owner for a free port:\n%s", out)
	}
}

// A held port that answers nothing must not be silently downgraded when the
// bind probe is also the only signal.
func TestPortOwnerBindErrorAlone(t *testing.T) {
	original := bindProbe
	bindProbe = func(string) error { return errors.New("address already in use") }
	t.Cleanup(func() { bindProbe = original })

	// Port 1 with nothing on it: the HTTP probe will fail to connect.
	out := report(t, "127.0.0.1", 1)
	if !strings.Contains(out, "address already in use") {
		t.Errorf("bind error not surfaced:\n%s", out)
	}
	if !strings.Contains(out, "did not answer HTTP") {
		t.Errorf("silent holder not described:\n%s", out)
	}
}

// probeHost exists because 0.0.0.0 and :: say what to accept on, not what to
// dial. Dialling them is undefined and fails outright on some stacks, which
// would reintroduce NEW-4 for every default install.
func TestProbeHostDialsSomethingReal(t *testing.T) {
	for _, bind := range []string{"", "0.0.0.0", "::", "[::]"} {
		if got := probeHost(bind); got != "127.0.0.1" {
			t.Errorf("probeHost(%q) = %q, want 127.0.0.1", bind, got)
		}
	}
	// A pinned listen_host is dialled as written, which is what makes the
	// check work for an install bound to one LAN address.
	if got := probeHost("192.168.1.50"); got != "192.168.1.50" {
		t.Errorf("probeHost pinned address = %q", got)
	}
}
