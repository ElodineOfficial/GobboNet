package supervisor

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// SwapAuto (1.8.0, #52): a switch the page makes on its own -- a chat that
// remembers another model, a character linked to one -- must never end a
// reply. One engine serves every device, so "a reply" is anyone's.

func TestSwapAutoWaitsForEveryReply(t *testing.T) {
	s, _, _ := swapFixture(t)
	done := s.BeginRequest() // another device's reply, mid-stream

	if err := s.SwapAuto("real.gguf"); !errors.Is(err, ErrBusy) {
		t.Fatalf("SwapAuto during a reply = %v, want ErrBusy", err)
	}
	if s.swapping {
		t.Fatal("a refused automatic switch marked a swap as running")
	}
	if !s.Status().Busy {
		t.Error("Status().Busy is false while a reply is being written")
	}

	done()
	if s.Status().Busy {
		t.Error("Status().Busy stays true after the reply ended")
	}
	// Past the busy check now: with a swap already running it reaches the
	// next refusal, which proves the name and the folder were accepted too.
	s.swapping = true
	if err := s.SwapAuto("real.gguf"); !errors.Is(err, ErrSwapInFlight) {
		t.Errorf("SwapAuto once nothing is in flight = %v, want it past the busy check", err)
	}
}

// A swap someone picked from the model menu behaves as it always has.
func TestManualSwapIsNotHeldByAReply(t *testing.T) {
	s, _, _ := swapFixture(t)
	defer s.BeginRequest()()
	s.swapping = true // stop before anything is started
	if err := s.Swap("real.gguf"); !errors.Is(err, ErrSwapInFlight) {
		t.Errorf("Swap during a reply = %v, want it past every check, as before", err)
	}
}

// The names an imported card or a synced chat can carry go through the same
// check as any other swap, busy or not.
func TestSwapAutoChecksTheNameFirst(t *testing.T) {
	s, _, _ := swapFixture(t)
	for _, bad := range []string{"../outside.gguf", "sub/x.gguf", `sub\x.gguf`, "notes.txt", "missing.gguf"} {
		if err := s.SwapAuto(bad); err == nil || errors.Is(err, ErrBusy) || errors.Is(err, ErrSwapInFlight) {
			t.Errorf("SwapAuto(%q) = %v, want it refused by name", bad, err)
		}
	}
	if p := s.Status().Phase; p != PhaseIdle {
		t.Errorf("phase after refusals = %q, want idle", p)
	}
}

func TestSwapModelRouteAnswers409BusyForAnAutomaticSwitch(t *testing.T) {
	s, _, _ := swapFixture(t)
	defer s.BeginRequest()()
	h := Handlers{Sup: s}

	rec := httptest.NewRecorder()
	h.HandleSwapModel(rec, httptest.NewRequest(http.MethodPost, "/swap-model",
		strings.NewReader(`{"file":"real.gguf","auto":true}`)))
	if rec.Code != http.StatusConflict {
		t.Fatalf("auto swap during a reply: %d %s, want 409", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["busy"] != true || body["phase"] == PhaseError {
		t.Errorf("answer = %v, want busy: true and no error phase (nothing went wrong)", body)
	}
	if s.swapping {
		t.Error("the route started a swap")
	}

	rec = httptest.NewRecorder()
	h.HandleSwapStatus(rec, httptest.NewRequest(http.MethodGet, "/swap-status", nil))
	if !strings.Contains(rec.Body.String(), `"busy":true`) {
		t.Errorf("/swap-status during a reply = %s, want busy: true", rec.Body.String())
	}
}
