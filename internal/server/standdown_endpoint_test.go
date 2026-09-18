// /standdown — the CONFIG panel's view of the idle timer.
//
// The endpoint has to be honest about two things the panel cannot work out for
// itself: whether this server can unload llama.cpp at all (it cannot in remote
// mode, where the process belongs to someone else), and whether a change was
// actually written to disk. A switch that silently does nothing, or that
// claims a save it did not make, is worse than no switch.
package server

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

func decodeStandDown(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("not JSON: %v\nbody: %s", err, body)
	}
	return out
}

// newTestServer builds a Server with no supervisor, which is remote mode: the
// exact case where the control must not pretend to work.
func TestStandDownReportsUnsupportedWithoutASupervisor(t *testing.T) {
	srv, _ := newTestServer(t)

	got := decodeStandDown(t, do(t, srv, http.MethodGet, "/standdown", nil).Body.Bytes())
	if got["supported"] != false {
		t.Errorf("supported: got %v, want false — there is no process to unload here", got["supported"])
	}

	// And a write must be refused rather than accepted into a void.
	rec := do(t, srv, http.MethodPost, "/standdown", strings.NewReader(`{"minutes":10}`))
	if rec.Code != http.StatusConflict {
		t.Errorf("POST without a supervisor: got %d, want 409", rec.Code)
	}
}

func TestStandDownRejectsNonsense(t *testing.T) {
	srv, _ := newTestServer(t)
	// Validation runs before the supervisor check for malformed input, so
	// these are about the parsing rather than the mode.
	for _, body := range []string{`not json`, `{}`, `{"minutes":-1}`, `{"minutes":1441}`} {
		rec := do(t, srv, http.MethodPost, "/standdown", strings.NewReader(body))
		if rec.Code == http.StatusOK {
			t.Errorf("body %q was accepted", body)
		}
	}
}

func TestStandDownIsGetOrPostOnly(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, m := range []string{http.MethodPut, http.MethodDelete, http.MethodPatch} {
		if rec := do(t, srv, m, "/standdown", nil); rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: got %d, want 405", m, rec.Code)
		}
	}
}

// The timeout reported has to be the one in the config, or the panel opens
// showing a value the server is not using.
func TestStandDownReportsTheConfiguredTimeout(t *testing.T) {
	srv, _ := newTestServer(t)
	srv.standDown.seconds.Store(7 * 60)

	got := decodeStandDown(t, do(t, srv, http.MethodGet, "/standdown", nil).Body.Bytes())
	if m, ok := got["minutes"].(float64); !ok || int(m) != 7 {
		t.Errorf("minutes: got %v, want 7", got["minutes"])
	}
}

// The config default is what decides whether anyone gets this feature without
// going looking for it.
func TestStandDownDefaultIsFiveMinutes(t *testing.T) {
	if config.DefaultIdleStandDownMinutes != 5 {
		t.Errorf("default is %d minutes, want 5", config.DefaultIdleStandDownMinutes)
	}
	if got := config.Default().IdleStandDownMinutes; got != 5 {
		t.Errorf("Default() carries %d, want 5", got)
	}
}

// 0 has to mean off, and has to survive a round trip through the file: a user
// who turns this off and finds it back on after a restart will not turn it off
// twice, they will stop trusting the panel.
func TestStandDownZeroPersistsAsOff(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/gobbonet.toml"
	if err := os.WriteFile(path, []byte("llm_url = \"http://127.0.0.1:8080\"\nidle_standdown_minutes = 5\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := config.Set(path, "idle_standdown_minutes", "0"); err != nil {
		t.Fatalf("set: %v", err)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if cfg.IdleStandDownMinutes != 0 {
		t.Errorf("after setting 0, config says %d", cfg.IdleStandDownMinutes)
	}
}

// The key has to be settable by name, since the launcher scripts and anyone
// hand-editing reach it that way.
func TestStandDownKeyIsListed(t *testing.T) {
	var found bool
	for _, k := range config.Keys() {
		if k == "idle_standdown_minutes" {
			found = true
		}
	}
	if !found {
		t.Error("idle_standdown_minutes is not in config keys")
	}
}
