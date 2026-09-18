// What the stand-down watchdog SAYS.
//
// The rule is tested in standdown_test.go. This file tests the output, which
// is a separate thing and was the actual complaint: "'model stand down' option
// does work in the config, I just can't see evidence of it working in the CMD".
// There was no evidence. WatchIdle called `ok, _ := s.standDownDecision(...)`
// and threw the reason away, so a watchdog that declined every tick for a
// legitimate reason was indistinguishable from one that was not running.
//
// It is also why these assertions are about wording and not just presence. The
// person reading this console is blind and hears it through a screen reader,
// one line at a time, with no colour, no column alignment and no ability to
// skim back. So: the verb comes first, one event is one line, and the line
// makes sense read on its own.
package supervisor

import (
	"fmt"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// recorder collects what WatchIdle would print.
type recorder struct {
	mu    sync.Mutex
	lines []string
}

func (r *recorder) log(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lines = append(r.lines, fmt.Sprintf(format, args...))
}

func (r *recorder) all() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.lines...)
}

func (r *recorder) text() string {
	return strings.Join(r.all(), "\n")
}

func (r *recorder) countContaining(sub string) int {
	n := 0
	for _, l := range r.all() {
		if strings.Contains(l, sub) {
			n++
		}
	}
	return n
}

// fastTicks shortens the watchdog's poll for the duration of a test.
func fastTicks(t *testing.T, d time.Duration) {
	t.Helper()
	prev := idleTick
	idleTick = d
	t.Cleanup(func() { idleTick = prev })
}

// watchFor runs WatchIdle long enough for n ticks and returns what it said.
func watchFor(t *testing.T, s *Supervisor, after time.Duration, ticks int) *recorder {
	t.Helper()
	const tick = 2 * time.Millisecond
	fastTicks(t, tick)

	rec := &recorder{}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		s.WatchIdle(func() time.Duration { return after }, stop, rec.log)
		close(done)
	}()
	time.Sleep(tick * time.Duration(ticks+2))
	close(stop)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("WatchIdle did not return after stop was closed")
	}
	return rec
}

// The regression, stated as output: a watchdog that declines has to say so.
func TestWatchIdleSaysWhyItIsNotStandingDown(t *testing.T) {
	s := ready(t)
	s.lastUse = time.Now()
	s.inFlight = 1 // a reason that will hold for the whole test

	rec := watchFor(t, s, time.Millisecond, 4)

	if !strings.Contains(rec.text(), "in flight") {
		t.Errorf("nothing said why stand-down was declined.\ngot:\n%s", rec.text())
	}
	if !strings.Contains(rec.text(), "[standdown]") {
		t.Errorf("the line is not findable by tag.\ngot:\n%s", rec.text())
	}
}

// ...but exactly once, or the thing it is meant to make visible is buried
// under it. Four ticks, one standing reason, one line.
func TestAStandingReasonIsSaidOnce(t *testing.T) {
	s := ready(t)
	s.lastUse = time.Now()
	s.inFlight = 1

	rec := watchFor(t, s, time.Millisecond, 6)

	if n := rec.countContaining("in flight"); n != 1 {
		t.Errorf("the same reason was reported %d times, want 1.\ngot:\n%s", n, rec.text())
	}
}

// The ordinary countdown is the one reason that must never be printed. "idle
// 45s of 5m0s" every fifteen seconds is not information, it is a wall of text
// between the user and the events they are listening for.
func TestTheCountdownIsNotNarrated(t *testing.T) {
	s := ready(t)
	s.lastUse = time.Now() // freshly used: every tick will say "idle Xs of Y"

	rec := watchFor(t, s, time.Hour, 6)

	for _, l := range rec.all() {
		if strings.Contains(l, "idle ") && strings.Contains(l, " of ") {
			t.Errorf("the countdown was narrated: %q", l)
		}
	}
}

// And when it does fire, it has to be unmissable and self-explanatory.
func TestTheUnloadIsAnnouncedPlainly(t *testing.T) {
	s := ready(t)
	s.current = "qwen3-8b-q4.gguf"
	s.lastUse = time.Now().Add(-time.Hour)
	// stop() would try to kill a process; there is none, and StandDown must
	// still flip the flag and report.
	s.cmd = &exec.Cmd{}

	rec := watchFor(t, s, time.Millisecond, 3)
	out := rec.text()

	for _, want := range []string{
		"UNLOADING",        // the verb, first, in a shape a screen reader stresses
		"qwen3-8b-q4.gguf", // WHICH model, since a swap may have changed it
		"VRAM",             // what was gained, in the word the setting uses
	} {
		if !strings.Contains(out, want) {
			t.Errorf("the unload announcement is missing %q.\ngot:\n%s", want, out)
		}
	}

	// The next thing the user needs to know is that nothing is broken.
	if !strings.Contains(out, "reloads it automatically") {
		t.Errorf("nothing said the model comes back by itself.\ngot:\n%s", out)
	}

	if !s.IsStoodDown() {
		t.Error("announced the unload without performing it")
	}
}

// One event, one line. A screen reader reads sequentially, so an event split
// across three lines is three events as far as the listener can tell.
func TestEveryLineIsOneLine(t *testing.T) {
	s := ready(t)
	s.lastUse = time.Now().Add(-time.Hour)

	rec := watchFor(t, s, time.Millisecond, 3)
	for _, l := range rec.all() {
		if strings.Contains(l, "\n") {
			t.Errorf("a single event spans multiple lines: %q", l)
		}
	}
}

// Turning it off is also a state worth hearing, once: otherwise "I never hear
// anything about stand-down" has two possible causes and no way to tell them
// apart.
func TestBeingDisabledIsSaidOnceAndNotRepeated(t *testing.T) {
	s := ready(t)
	rec := watchFor(t, s, 0, 6)

	if n := rec.countContaining("off"); n != 1 {
		t.Errorf("disabled was reported %d times, want exactly 1.\ngot:\n%s", n, rec.text())
	}
	if !strings.Contains(rec.text(), "stays loaded") {
		t.Errorf("the disabled line does not say what that means.\ngot:\n%s", rec.text())
	}
}

// A reason that CHANGES is news, and has to be reported again.
func TestAChangedReasonIsReportedAgain(t *testing.T) {
	const tick = 3 * time.Millisecond
	fastTicks(t, tick)

	s := ready(t)
	s.lastUse = time.Now()
	s.inFlight = 1

	rec := &recorder{}
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		s.WatchIdle(func() time.Duration { return time.Millisecond }, stop, rec.log)
		close(done)
	}()

	time.Sleep(tick * 4)
	s.mu.Lock()
	s.inFlight = 0
	s.swapping = true // a different refusal
	s.mu.Unlock()
	time.Sleep(tick * 4)

	close(stop)
	<-done

	out := rec.text()
	if !strings.Contains(out, "in flight") {
		t.Errorf("the first reason was not reported.\ngot:\n%s", out)
	}
	if !strings.Contains(out, "swap") {
		t.Errorf("the reason changed and nothing was said.\ngot:\n%s", out)
	}
}

// WatchIdle is also called with a nil logger (nothing is listening). It must
// not panic, because the only thing worse than a silent watchdog is one that
// takes the server down.
func TestWatchIdleToleratesANilLogger(t *testing.T) {
	fastTicks(t, time.Millisecond)
	s := ready(t)
	s.lastUse = time.Now().Add(-time.Hour)

	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		s.WatchIdle(func() time.Duration { return time.Millisecond }, stop, nil)
		close(done)
	}()
	time.Sleep(10 * time.Millisecond)
	close(stop)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("WatchIdle hung with a nil logger")
	}
}

// "already stood down" must not be reported, because the line that unloaded it
// said so fifteen seconds earlier and a second line reads as a second event.
func TestTheAlreadyStoodDownRefusalIsNotRepeatedBackAtTheUser(t *testing.T) {
	s := ready(t)
	s.lastUse = time.Now().Add(-time.Hour)

	// Enough ticks for the unload AND several refusals after it.
	rec := watchFor(t, s, time.Millisecond, 8)
	out := rec.text()

	if !strings.Contains(out, "UNLOADING") {
		t.Fatalf("setup failed: it never stood down.\ngot:\n%s", out)
	}
	if strings.Contains(out, "already stood down") {
		t.Errorf("the console was told twice that the model is down.\ngot:\n%s", out)
	}
	// But the rule still gives the reason to anyone who asks, since /standdown
	// reports it and an empty reason would read as "about to happen".
	if _, why := s.standDownDecision(time.Now(), time.Minute); why != reasonAlreadySaid {
		t.Errorf("the reason was blanked rather than quietened: %q", why)
	}
}
