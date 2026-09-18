// The idle stand-down rule.
//
// Standing down unloads a model to free several gigabytes of VRAM. Getting the
// DECISION wrong is not a slow reply, it is a truncated one — so the rule is
// separated from the acting on it (standDownDecision) and tested here without
// launching anything. Every refusal returns its reason, because a watchdog
// that silently declines is impossible to diagnose from a log.
package supervisor

import (
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"
)

// ready builds a Supervisor that looks like one with a model loaded and
// serving, which is the only state stand-down is allowed to act on.
func ready(t *testing.T) *Supervisor {
	t.Helper()
	s, err := New(Options{LLMURL: "http://127.0.0.1:8080"})
	if err != nil {
		t.Fatal(err)
	}
	s.status = Status{Phase: PhaseReady}
	s.current = "model.gguf"
	// A non-nil cmd stands in for "a process is running". Nothing in the
	// decision path touches it beyond the nil check.
	s.cmd = &exec.Cmd{}
	return s
}

func TestStandDownWaitsForTheTimeout(t *testing.T) {
	s := ready(t)
	now := time.Now()
	s.lastUse = now.Add(-2 * time.Minute)

	if ok, why := s.standDownDecision(now, 5*time.Minute); ok {
		t.Error("stood down after 2 minutes of a 5 minute timeout")
	} else if !strings.Contains(why, "idle 2m") {
		t.Errorf("reason: got %q, want it to name how long it has been idle", why)
	}

	if ok, _ := s.standDownDecision(now.Add(3*time.Minute+time.Second), 5*time.Minute); !ok {
		t.Error("did not stand down once the timeout had passed")
	}
}

func TestStandDownIsOffAtZero(t *testing.T) {
	s := ready(t)
	s.lastUse = time.Now().Add(-100 * time.Hour)
	ok, why := s.standDownDecision(time.Now(), 0)
	if ok {
		t.Fatal("stood down with the timeout disabled")
	}
	if why != "disabled" {
		t.Errorf("reason: got %q, want \"disabled\"", why)
	}
}

// The case a last-activity timestamp alone gets wrong: a long generation looks
// exactly like an idle one. The request arrived six minutes ago, nothing has
// happened since, and the reply is still streaming.
func TestStandDownRefusesWhileARequestIsInFlight(t *testing.T) {
	s := ready(t)
	done := s.BeginRequest()

	// Six minutes later, past any sane timeout, still mid-generation.
	now := time.Now().Add(6 * time.Minute)
	ok, why := s.standDownDecision(now, 5*time.Minute)
	if ok {
		t.Fatal("stood down in the middle of a generation")
	}
	if !strings.Contains(why, "in flight") {
		t.Errorf("reason: got %q, want it to name the in-flight request", why)
	}

	// Finishing restarts the clock from the END of the generation, not its
	// start — otherwise a six-minute reply is already past a five-minute
	// timeout the instant it completes.
	done()
	if ok, _ := s.standDownDecision(time.Now().Add(time.Second), 5*time.Minute); ok {
		t.Error("stood down immediately after a long generation finished")
	}
	if ok, _ := s.standDownDecision(time.Now().Add(6*time.Minute), 5*time.Minute); !ok {
		t.Error("did not stand down once the post-generation idle period had passed")
	}
}

func TestBeginRequestCounterIsBalanced(t *testing.T) {
	s := ready(t)
	a, b, c := s.BeginRequest(), s.BeginRequest(), s.BeginRequest()
	if s.inFlight != 3 {
		t.Fatalf("inFlight: got %d, want 3", s.inFlight)
	}
	a()
	a() // double release must not double-decrement
	a()
	if s.inFlight != 2 {
		t.Errorf("inFlight after a double release: got %d, want 2", s.inFlight)
	}
	b()
	c()
	if s.inFlight != 0 {
		t.Errorf("inFlight: got %d, want 0", s.inFlight)
	}

	// Concurrent traffic must not corrupt the count, since this is what
	// stands between a stream and being cut off.
	var wg sync.WaitGroup
	for i := 0; i < 200; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); s.BeginRequest()() }()
	}
	wg.Wait()
	if s.inFlight != 0 {
		t.Errorf("inFlight after 200 concurrent requests: got %d, want 0", s.inFlight)
	}
}

func TestStandDownRefusesUnlessReady(t *testing.T) {
	old := time.Now().Add(-time.Hour)

	for _, phase := range []string{PhaseIdle, PhaseStarting, PhaseError} {
		s := ready(t)
		s.status.Phase = phase
		s.lastUse = old
		ok, why := s.standDownDecision(time.Now(), time.Minute)
		if ok {
			t.Errorf("stood down while phase was %q", phase)
		}
		if !strings.Contains(why, phase) {
			t.Errorf("phase %q: reason %q should name the phase", phase, why)
		}
	}

	// Mid-swap: the model is already being replaced, and stopping it from
	// underneath would race the swap's own start.
	s := ready(t)
	s.swapping = true
	s.lastUse = old
	if ok, why := s.standDownDecision(time.Now(), time.Minute); ok {
		t.Error("stood down during a swap")
	} else if !strings.Contains(why, "swap") {
		t.Errorf("reason: got %q, want it to name the swap", why)
	}

	// Already down: not an error, just nothing to do.
	s = ready(t)
	s.stoodDown = true
	s.lastUse = old
	if ok, why := s.standDownDecision(time.Now(), time.Minute); ok {
		t.Error("stood down twice")
	} else if !strings.Contains(why, "already") {
		t.Errorf("reason: got %q", why)
	}

	// No process to stop.
	s = ready(t)
	s.cmd = nil
	s.lastUse = old
	if ok, _ := s.standDownDecision(time.Now(), time.Minute); ok {
		t.Error("stood down with no process running")
	}
}

// A model loaded at boot and never used has no clock to measure from. Rather
// than treating "never used" as infinitely idle and unloading it immediately —
// which would fight anyone who starts the app and then goes to make tea before
// typing — the first check starts the clock and the next one decides.
func TestStandDownStartsTheClockOnFirstCheck(t *testing.T) {
	s := ready(t)
	if !s.lastUse.IsZero() {
		t.Fatal("expected no recorded use on a fresh supervisor")
	}

	now := time.Now()
	ok, why := s.standDownDecision(now, time.Minute)
	if ok {
		t.Error("unloaded a model that had never been used, with no idle clock to justify it")
	}
	// The wording is asserted loosely but the MEANING is not: the reason has to
	// say that nothing has been sent, because this refusal appears on the
	// console fifteen seconds after every startup and is the first thing a user
	// hears from the feature.
	if !strings.Contains(why, "nothing has been sent") {
		t.Errorf("reason: got %q, want it to say nothing has been sent yet", why)
	}
	if s.lastUse.IsZero() {
		t.Error("the check did not start the clock")
	}

	if ok, _ := s.standDownDecision(now.Add(2*time.Minute), time.Minute); !ok {
		t.Error("did not stand down once the clock it started had run out")
	}
}

func TestMarkActivityResetsTheClock(t *testing.T) {
	s := ready(t)
	now := time.Now()
	s.lastUse = now.Add(-time.Hour)

	if ok, _ := s.standDownDecision(now, time.Minute); !ok {
		t.Fatal("expected an hour-idle supervisor to stand down")
	}

	s.MarkActivity()
	if ok, why := s.standDownDecision(time.Now(), time.Minute); ok {
		t.Errorf("stood down right after activity (reason field: %q)", why)
	}
}

// Several requests arriving at once against a stood-down model must produce
// ONE reload, not one per request: the GPU has only just been given its memory
// back and loading the same model twice into it is the failure this guards.
func TestEnsureAwakeCoalesces(t *testing.T) {
	s := ready(t)
	s.stoodDown = true
	s.standFile = "model.gguf"

	var loads int
	var mu sync.Mutex
	// Stand in for the real reload, which would launch a process. What is
	// under test is the coalescing, not the launch.
	fakeWake := func() error {
		mu.Lock()
		loads++
		mu.Unlock()
		time.Sleep(20 * time.Millisecond)
		s.mu.Lock()
		s.stoodDown = false
		s.mu.Unlock()
		return nil
	}

	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Mirrors EnsureAwake's structure with the launch swapped out.
			for {
				s.mu.Lock()
				if !s.stoodDown {
					s.mu.Unlock()
					return
				}
				if ch := s.waking; ch != nil {
					s.mu.Unlock()
					<-ch
					continue
				}
				ch := make(chan struct{})
				s.waking = ch
				s.mu.Unlock()

				_ = fakeWake()

				s.mu.Lock()
				s.waking = nil
				s.mu.Unlock()
				close(ch)
				return
			}
		}()
	}
	wg.Wait()

	if loads != 1 {
		t.Errorf("reloaded %d times for 8 concurrent requests, want 1", loads)
	}
	if s.IsStoodDown() {
		t.Error("still reports stood down after waking")
	}
}

func TestEnsureAwakeIsANoOpWhenUp(t *testing.T) {
	s := ready(t)
	if err := s.EnsureAwake(); err != nil {
		t.Errorf("waking an already-running supervisor: %v", err)
	}
}

// Nothing to reload has to be an error rather than a silent success, or the
// proxy forwards to a port with nothing behind it and the user gets a
// connection refused they cannot act on.
func TestWakeWithNothingLoadedFails(t *testing.T) {
	s := ready(t)
	s.stoodDown = true
	s.standFile = ""
	s.current = ""
	if err := s.EnsureAwake(); err == nil {
		t.Error("expected an error when there is no model to bring back")
	}
}

func TestStandDownSetsItsOwnPhase(t *testing.T) {
	// PhaseStoodDown has to be distinct from PhaseIdle: one means a model was
	// deliberately unloaded and the next message will cost a load, the other
	// means none was ever started. The UI says different things about them.
	if PhaseStoodDown == PhaseIdle {
		t.Fatal("stood-down and idle must be distinguishable")
	}
	if PhaseStoodDown == PhaseReady || PhaseStoodDown == PhaseError {
		t.Fatal("stood-down collides with an existing phase")
	}
}
