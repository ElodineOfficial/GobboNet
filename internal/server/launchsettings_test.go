package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

// /launch-settings (1.8.0, PR #58). open_browser is read and written through
// config.toml, because that is what the launchers read at the next start.

func TestLaunchSettingsDefaultIsOpen(t *testing.T) {
	srv, _ := newTestServer(t)
	rec := do(t, srv, http.MethodGet, "/launch-settings", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /launch-settings: %d", rec.Code)
	}
	if got := decode(t, rec)["open_browser"]; got != true {
		t.Errorf("open_browser = %v on a config that does not mention it, want true", got)
	}
}

// Any signed-in device, not only this PC: the test request comes from
// httptest's 192.0.2.1, which fromThisPC refuses.
func TestLaunchSettingsSaveFromAnyDeviceToConfigToml(t *testing.T) {
	srv, cfg := newTestServer(t)
	if fromThisPC(newReq(http.MethodPost, "/launch-settings", nil)) {
		t.Fatal("the test request counts as this PC; it must stand for a phone")
	}

	rec := do(t, srv, http.MethodPost, "/launch-settings", strings.NewReader(`{"open_browser":false}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST false from another device: %d %s", rec.Code, rec.Body.String())
	}
	if got := decode(t, rec)["open_browser"]; got != false {
		t.Errorf("answer says open_browser = %v, want false", got)
	}
	onDisk, err := config.Load(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	if onDisk.OpenBrowser {
		t.Error("config.toml still says open_browser = true: the launchers would keep opening a tab")
	}
	if got := decode(t, do(t, srv, http.MethodGet, "/launch-settings", nil))["open_browser"]; got != false {
		t.Errorf("GET after saving false = %v", got)
	}

	rec = do(t, srv, http.MethodPost, "/launch-settings", strings.NewReader(`{"open_browser":true}`))
	if rec.Code != http.StatusOK || decode(t, rec)["open_browser"] != true {
		t.Errorf("POST true back: %d %s", rec.Code, rec.Body.String())
	}
}

// GET reads the file, so an edit made in the Config File editor (or by hand)
// shows here without a restart.
func TestLaunchSettingsReadsTheFileNotTheStartupValue(t *testing.T) {
	srv, cfg := newTestServer(t)
	if err := config.Set(cfg.Path, "open_browser", "false"); err != nil {
		t.Fatal(err)
	}
	if got := decode(t, do(t, srv, http.MethodGet, "/launch-settings", nil))["open_browser"]; got != false {
		t.Errorf("GET after config.toml was changed underneath = %v, want false", got)
	}
}

func TestLaunchSettingsRefusesBadRequests(t *testing.T) {
	srv, cfg := newTestServer(t)
	for _, body := range []string{`not json`, `{}`, `{"open_browser":"no"}`} {
		rec := do(t, srv, http.MethodPost, "/launch-settings", strings.NewReader(body))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("POST %s: %d, want 400", body, rec.Code)
		}
	}
	// A page on another site cannot flip it, password or not.
	req := newReq(http.MethodPost, "/launch-settings", strings.NewReader(`{"open_browser":false}`))
	req.Header.Set("Origin", "https://elsewhere.example")
	rec := httptest.NewRecorder()
	srv.ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Errorf("cross-site POST: %d, want 403", rec.Code)
	}
	if onDisk, _ := config.Load(cfg.Path); !onDisk.OpenBrowser {
		t.Error("a refused request changed config.toml")
	}
	if rec := do(t, srv, http.MethodPut, "/launch-settings", nil); rec.Code != http.StatusMethodNotAllowed {
		t.Errorf("PUT: %d, want 405", rec.Code)
	}
}
