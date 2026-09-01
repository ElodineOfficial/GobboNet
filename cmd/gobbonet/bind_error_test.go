package main

import (
	"errors"
	"net"
	"os"
	"strings"
	"syscall"
	"testing"

	"github.com/jmccardle/gobbonet/internal/config"
)

// listenErr wraps errno the way net.Listen delivers it, so these tests
// exercise the same unwrapping the real call site does.
func listenErr(errno error) error {
	return &net.OpError{
		Op:   "listen",
		Net:  "tcp",
		Addr: &net.TCPAddr{IP: net.IPv4zero, Port: 9066},
		Err:  os.NewSyscallError("bind", errno),
	}
}

// TestWSAEACCESIsNotReportedAsInUse is the regression this classification
// exists for.
//
// WSAEACCES (10013) was previously bucketed with "already in use", so a Windows
// user whose port fell inside a Hyper-V or WSL reserved range was told to go
// find and kill the process holding it. There is no such process — netstat
// shows nothing, because the range is RESERVED rather than occupied — and the
// advice sent them past the one command that would have shown the real cause.
func TestWSAEACCESIsNotReportedAsInUse(t *testing.T) {
	err := listenErr(syscall.Errno(10013))

	if isAddrInUse(err) {
		t.Error("WSAEACCES classified as an in-use error")
	}
	if !isPermissionDenied(err) {
		t.Error("WSAEACCES not classified as a permission failure")
	}

	msg := bindError(config.Default(), err).Error()
	if strings.Contains(msg, "already in use") {
		t.Errorf("permission failure reported as in-use:\n%s", msg)
	}
	if !strings.Contains(msg, "excludedportrange") {
		t.Errorf("permission failure does not name the reserved-range check:\n%s", msg)
	}
}

// TestAddrInUseKeepsItsMessage guards the other side of the split: the common
// failure must still get the message written for it.
func TestAddrInUseKeepsItsMessage(t *testing.T) {
	for name, err := range map[string]error{
		"EADDRINUSE":    listenErr(syscall.EADDRINUSE),
		"WSAEADDRINUSE": listenErr(syscall.Errno(10048)),
	} {
		t.Run(name, func(t *testing.T) {
			if !isAddrInUse(err) {
				t.Fatal("not classified as in-use")
			}
			msg := bindError(config.Default(), err).Error()
			if !strings.Contains(msg, "already in use") {
				t.Errorf("in-use error lost its message:\n%s", msg)
			}
		})
	}
}

// TestEACCESIsPermissionDenied covers the POSIX side, where a port below 1024
// without root produces the same class of failure.
func TestEACCESIsPermissionDenied(t *testing.T) {
	err := listenErr(syscall.EACCES)
	if !isPermissionDenied(err) {
		t.Fatal("EACCES not classified as a permission failure")
	}
	msg := bindError(config.Default(), err).Error()
	if !strings.Contains(msg, "below 1024") {
		t.Errorf("permission failure omits the privileged-port note:\n%s", msg)
	}
}

// TestUnclassifiedErrorPassesThrough keeps bindError from inventing an
// explanation. A failure it does not recognise is returned unchanged rather
// than dressed as one of the two it does, which would send the reader after
// the wrong thing.
func TestUnclassifiedErrorPassesThrough(t *testing.T) {
	want := errors.New("something else entirely")
	if got := bindError(config.Default(), want); !errors.Is(got, want) {
		t.Errorf("bindError rewrote an unrecognised error: %v", got)
	}
}

// TestBindErrorsWrapTheCause keeps the original OS text reachable. The
// explanation is a layer on top of the real error, never a replacement for it;
// a support report needs the errno.
func TestBindErrorsWrapTheCause(t *testing.T) {
	for name, errno := range map[string]syscall.Errno{
		"in use":            syscall.EADDRINUSE,
		"permission denied": syscall.EACCES,
	} {
		t.Run(name, func(t *testing.T) {
			cause := listenErr(errno)
			if got := bindError(config.Default(), cause); !errors.Is(got, errno) {
				t.Errorf("errno no longer reachable through the wrapped error: %v", got)
			}
		})
	}
}

// TestLanBindHelpNamesTheConfigFile keeps the advice actionable: a user told to
// change a setting needs to know which file it lands in.
func TestLanBindHelpNamesTheConfigFile(t *testing.T) {
	cfg := config.Default()
	cfg.Path = "/etc/gobbonet/config.toml"

	joined := strings.Join(lanBindHelp(cfg), "\n")
	if !strings.Contains(joined, cfg.Path) {
		t.Errorf("help does not name the config file:\n%s", joined)
	}
	if !strings.Contains(joined, "excludedportrange") {
		t.Errorf("help omits the Windows reserved-range check:\n%s", joined)
	}
}
