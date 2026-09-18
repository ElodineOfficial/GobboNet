// The [ui] table from gobbonet.toml, served to the chat page.
//
// The server deliberately does not interpret this table. The keys are the
// frontend's own settings, defined in js/04-state.js and growing every
// release; validating here would mean a second list of every setting kept in
// step by hand, and the drift would be silent — a setting added to the UI
// would simply stop being presettable with nothing to notice it. So these
// tests assert that values pass through UNCHANGED, including ones Go has no
// opinion about, rather than asserting on any schema.
package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

func decodeUI(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var out struct {
		UI map[string]any `json:"ui"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("not JSON: %v\nbody: %s", err, body)
	}
	return out.UI
}

func TestUIDefaultsEmptyByDefault(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/ui-defaults.json", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("got %d, want 200", rec.Code)
	}
	// An object, never null: the client does Object.keys() on it, and a config
	// with no [ui] section is the overwhelmingly common case.
	ui := decodeUI(t, rec.Body.Bytes())
	if ui == nil {
		t.Error("got null, want an empty object")
	}
	if len(ui) != 0 {
		t.Errorf("got %v, want empty", ui)
	}
}

func TestUIDefaultsPassesValuesThroughUntouched(t *testing.T) {
	srv, _ := newTestServer(t)
	// On srv.cfg, not on the returned copy: newTestServer hands back a
	// config.Config by value and Server holds its own, so mutating the copy
	// changes nothing the handler will ever read.
	srv.cfg.UI = map[string]any{
		"stream_replies":   false,
		"auto_scroll":      "off",
		"token_limit":      int64(8192),
		"streamRepliesAlt": true,
		// A key Go knows nothing about must still arrive: the browser is the
		// only thing that can say whether it is a real setting.
		"some_future_setting": "whatever",
	}

	ui := decodeUI(t, do(t, srv, http.MethodGet, "/ui-defaults.json", nil).Body.Bytes())
	if len(ui) != 5 {
		t.Fatalf("got %d entries, want 5: %v", len(ui), ui)
	}
	if ui["stream_replies"] != false {
		t.Errorf("stream_replies: got %v, want false", ui["stream_replies"])
	}
	if ui["auto_scroll"] != "off" {
		t.Errorf("auto_scroll: got %v, want \"off\"", ui["auto_scroll"])
	}
	if n, ok := ui["token_limit"].(float64); !ok || int(n) != 8192 {
		t.Errorf("token_limit: got %v (%T), want 8192", ui["token_limit"], ui["token_limit"])
	}
	if ui["some_future_setting"] != "whatever" {
		t.Errorf("an unrecognised key was dropped: %v", ui)
	}
}

func TestUIDefaultsIsReadOnly(t *testing.T) {
	srv, _ := newTestServer(t)
	for _, m := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		if rec := do(t, srv, m, "/ui-defaults.json", nil); rec.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s: got %d, want 405", m, rec.Code)
		}
	}
}
