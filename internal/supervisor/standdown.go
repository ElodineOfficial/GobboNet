package supervisor

import (
	"fmt"
	"log"
	"strings"
	"sync"
	"time"
)

// PhaseStoodDown is reported while the model has been deliberately unloaded to
// free VRAM. It is distinct from PhaseIdle, which means "no model has been
// started yet" — the difference matters to the UI, because one of them is
// about to cost a model load and the other is not.
const PhaseStoodDown = "stood_down"

/*
Idle stand-down.

llama-server holds the whole model in VRAM for as long as it runs, whether or
not anyone is talking to it. Leaving the app open overnight therefore pins
several gigabytes against nothing, and a machine that also wants that memory
for something else does not get it back until GobboNet is closed.

WHY THIS IS SERVER-SIDE. The obvious place for an idle timer is the page, and
it is the wrong one: the case that matters most is the browser being CLOSED.
A tab that has been shut cannot run a timer, so a client-side implementation
would free VRAM in every situation except the one where the user has most
obviously finished. The timer belongs to the process that owns the child.

WHAT COUNTS AS USE. Generation, and nothing else. Not the page being open, not
a poll — an idle open tab is exactly the case this exists for.

That last sentence used to be followed by "Generation is the only thing the
frontend sends through the proxy, so that distinction needs no special-casing
today", and it is left here because it is instructive. It was never true. The
chat page also sends /health, /props, /tokenize and /apply-template down the
same proxy, and it polls /health every five seconds for as long as the tab is
open. Every one of those called MarkActivity. So the clock was reset twelve
times a minute by a page doing nothing, and the feature could not fire in the
one situation it was written for. The timer was never the problem.

The classification now lives in internal/server/standdown.go (usePaths and
countsAsUse), beside the routes it is about, and is pinned by
standdown_activity_test.go against the paths js/ actually calls.

WHAT MAKES IT SAFE. Standing down mid-generation would look like a crash, so
the decision is refused while any request is in flight, while a swap is
running, and unless the supervisor is actually Ready. The cost of getting this
wrong is not a slow reply, it is a truncated one.

REMOTE MODE. Not wired up there at all, and deliberately: in remote mode
llama.cpp is somebody else's process on somebody else's machine. Stopping it
is not ours to do.
*/

// MarkActivity records that the backend was used.
//
// Called only for requests the server has classified as generation. Calling it
// for everything that reaches the proxy is what broke this feature; see the
// note above.
func (s *Supervisor) MarkActivity() {
	s.mu.Lock()
	s.lastUse = time.Now()
	s.mu.Unlock()
}

// BeginRequest registers an in-flight request and returns the function that
// ends it.
//
// A counter rather than a timestamp because a long generation is exactly the
// case that looks idle: the request arrived four minutes ago, nothing has
// happened since, and the reply is still streaming. Judging by last-activity
// alone would stand down in the middle of it.
func (s *Supervisor) BeginRequest() func() {
	s.mu.Lock()
	s.inFlight++
	s.lastUse = time.Now()
	s.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if s.inFlight > 0 {
				s.inFlight--
			}
			// Marked again on the way out so the clock runs from the END of a
			// long generation. Otherwise a reply that took six minutes to
			// write would already be past a five-minute timeout the instant it
			// finished.
			s.lastUse = time.Now()
			s.mu.Unlock()
		})
	}
}

// IsStoodDown reports whether the model has been unloaded to free VRAM.
func (s *Supervisor) IsStoodDown() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stoodDown
}

// IdleSince reports the last time the backend was used. Zero before any use.
func (s *Supervisor) IdleSince() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastUse
}

// reasonAlreadySaid marks a refusal the console has already been told about, so
// WatchIdle keeps quiet about it. The reason is still returned rather than
// blanked, because /standdown reports it and "" would read as "it is about to
// happen".
const reasonAlreadySaid = "already stood down"

// standDownDecision is the whole rule, separated from the acting on it so it
// can be tested without launching a model. Returns the reason it declined,
// for the log line — a watchdog that silently does nothing is impossible to
// diagnose.
func (s *Supervisor) standDownDecision(now time.Time, after time.Duration) (bool, string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if after <= 0 {
		return false, "disabled"
	}
	if s.stoodDown {
		// Not worth reporting: the line that unloaded it said so, and saying it
		// again fifteen seconds later reads like a second event.
		return false, reasonAlreadySaid
	}
	if s.swapping {
		return false, "a swap is in progress"
	}
	if s.inFlight > 0 {
		return false, fmt.Sprintf("%d request(s) in flight", s.inFlight)
	}
	if s.status.Phase != PhaseReady {
		return false, "phase is " + s.status.Phase
	}
	if s.cmd == nil {
		return false, "no process running"
	}
	if s.lastUse.IsZero() {
		// Nothing has ever been sent. The model was loaded at boot and has sat
		// unused since, which is the clearest case of all for releasing it —
		// but there is no clock to measure from, so start one now and let the
		// next tick decide.
		s.lastUse = now
		return false, "nothing has been sent yet -- the idle clock starts now"
	}
	if idle := now.Sub(s.lastUse); idle < after {
		return false, fmt.Sprintf("idle %s of %s", idle.Truncate(time.Second), after)
	}
	return true, ""
}

// StandDown unloads the model, freeing its VRAM. The model is remembered so
// EnsureAwake can bring the same one back.
func (s *Supervisor) StandDown() {
	s.mu.Lock()
	if s.stoodDown {
		s.mu.Unlock()
		return
	}
	file := s.current
	name := s.status.Name
	s.stoodDown = true
	s.standFile = file
	s.mu.Unlock()

	s.stop()
	s.setStatus(PhaseStoodDown, file, name,
		"Model unloaded to free VRAM. It will reload on the next message.", 0)
}

// EnsureAwake reloads the model if it was stood down, and blocks until it is
// serving. Safe to call concurrently: the first caller does the work and the
// rest wait for the same load rather than starting several.
func (s *Supervisor) EnsureAwake() error {
	for {
		s.mu.Lock()
		if !s.stoodDown {
			s.mu.Unlock()
			return nil
		}
		if ch := s.waking; ch != nil {
			// Someone else is already reloading. Wait for that, rather than
			// queueing a second load of the same model onto a GPU that has
			// only just been given its memory back.
			s.mu.Unlock()
			<-ch
			continue
		}
		ch := make(chan struct{})
		s.waking = ch
		file := s.standFile
		if file == "" {
			file = s.current
		}
		s.mu.Unlock()

		// Announced, because this is the delay the user is sitting through. A
		// stood-down model reloads before the reply, so the first message after
		// a pause is slow on purpose -- and a slow reply with no explanation is
		// indistinguishable from a hang.
		log.Printf("[standdown] WAKING -- reloading %s for your message", file)

		// The success line comes from announceLoad inside wake(), so it carries
		// the device and the layer split rather than just a duration. Two lines
		// for one event is the clutter this round is removing.
		err := s.wake(file)
		if err != nil {
			log.Printf("[standdown] could not reload %s: %v", file, err)
		}

		s.mu.Lock()
		s.waking = nil
		s.mu.Unlock()
		close(ch)
		return err
	}
}

func (s *Supervisor) wake(file string) error {
	if file == "" {
		return fmt.Errorf("nothing to reload: no model was loaded before standing down")
	}
	began := time.Now()
	startedAt := began.Unix()
	s.setStatus(PhaseStarting, file, file, "Reloading model after idle stand-down", startedAt)

	if err := s.start(file); err != nil {
		s.setStatus(PhaseError, file, file, err.Error(), startedAt)
		return err
	}
	if err := s.waitHealthy(time.Now().Add(swapTimeout)); err != nil {
		s.setStatus(PhaseError, file, file, err.Error(), startedAt)
		return err
	}
	s.announceLoad("standdown", "reloaded", file, began)

	s.mu.Lock()
	s.stoodDown = false
	s.standFile = ""
	s.previous = file
	s.lastUse = time.Now()
	s.mu.Unlock()

	s.setStatus(PhaseReady, file, file, "Ready", startedAt)
	if s.OnReady != nil {
		s.OnReady()
	}
	return nil
}

// idleTick is how often the rule is consulted.
//
// A fixed short tick rather than a timer armed for the deadline: the timeout is
// mutable, and re-arming correctly on every change is more moving parts than
// simply asking once every fifteen seconds. The check itself is a mutex and a
// subtraction.
//
// A var so the tests can shorten it. What needs testing here is not the
// arithmetic — standDownDecision covers that — but WHAT REACHES THE SCREEN,
// and a test that has to wait fifteen seconds per tick to find out is a test
// nobody runs.
var idleTick = 15 * time.Second

// WatchIdle runs the stand-down timer until stop is closed.
//
// `after` is read through a function rather than passed by value so the
// timeout can be changed at runtime without restarting the server — the
// setting is worth nothing if changing it needs a restart, since the people
// most likely to change it are the ones it has just surprised.
func (s *Supervisor) WatchIdle(after func() time.Duration, stop <-chan struct{}, log func(string, ...any)) {
	t := time.NewTicker(idleTick)
	defer t.Stop()

	// The last refusal reason that was reported, so a standing condition is
	// announced once rather than every tick.
	lastReason := "not checked yet"

	for {
		select {
		case <-stop:
			return
		case now := <-t.C:
			d := after()
			if d <= 0 {
				if lastReason != "disabled" && log != nil {
					log("[standdown] off -- the model stays loaded until GobboNet closes")
				}
				lastReason = "disabled"
				continue
			}
			ok, reason := s.standDownDecision(now, d)
			if !ok {
				// SAY WHY. This reason used to be discarded -- the call read
				// `ok, _ :=` -- so when stand-down did not happen there was
				// nothing on screen at all, and the only way to tell a working
				// feature from a broken one was to watch VRAM in another tool.
				// The report was "it does work in the config, I just can't see
				// evidence of it working in the CMD". There was none to see.
				//
				// Only on CHANGE, and never for the ordinary countdown: "idle
				// 45s of 5m0s" every fifteen seconds would bury the thing it is
				// meant to make visible. A reason that persists is said once.
				if reason != lastReason && reason != reasonAlreadySaid &&
					!strings.HasPrefix(reason, "idle ") && log != nil {
					log("[standdown] holding off: %s", reason)
				}
				lastReason = reason
				continue
			}
			lastReason = ""
			s.mu.Lock()
			file := s.current
			s.mu.Unlock()
			if log != nil {
				// Verb first and one line, because this is the event people are
				// listening for and it has to be recognisable without reading
				// around it.
				log("[standdown] UNLOADING %s after %s idle -- its VRAM is now free", file, d)
			}
			s.StandDown()
			if log != nil {
				log("[standdown] model unloaded. Your next message reloads it automatically.")
			}
		}
	}
}
