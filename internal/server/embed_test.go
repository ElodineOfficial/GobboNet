package server

import (
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

// 1.8.0 (#15): /health-fileserver says who answers /embed.
func TestHealthReportsTheEmbeddingServer(t *testing.T) {
	srv, _ := newTestServer(t)
	body := decode(t, do(t, srv, http.MethodGet, "/health-fileserver", nil))
	if body["embed"] != "external" {
		t.Errorf("no local engine: embed = %v, want external", body["embed"])
	}

	srv.cfg.EmbedMode = config.EmbedOff
	if body := decode(t, do(t, srv, http.MethodGet, "/health-fileserver", nil)); body["embed"] != "off" {
		t.Errorf("embed_mode off: %v", body["embed"])
	}

	// A managed server whose model is missing says so, with the reason.
	srv.cfg.EmbedMode = config.EmbedManaged
	dir := t.TempDir()
	e, err := supervisor.NewEmbedder(supervisor.EmbedOptions{
		ServerExe: filepath.Join(dir, "llama-server"), Model: filepath.Join(dir, "nomic.gguf"),
		Pin: config.EmbedModelSHA256, URL: "http://127.0.0.1:1",
	})
	if err != nil {
		t.Fatal(err)
	}
	srv.AttachEmbedder(e)
	e.Start()
	deadline := time.Now().Add(5 * time.Second)
	for e.Status().State != supervisor.EmbedFailed && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	body = decode(t, do(t, srv, http.MethodGet, "/health-fileserver", nil))
	detail, _ := body["embed_detail"].(string)
	if body["embed"] != "failed" || !strings.Contains(detail, "no embedding model at") {
		t.Errorf("missing model: embed=%v detail=%q", body["embed"], detail)
	}
}

func TestEmbedRole(t *testing.T) {
	c := config.Default()
	c.ServerExe = "/opt/llama/llama-server"
	for _, tc := range []struct {
		mode, url string
		engine    bool
		want      string
	}{
		{"managed", "http://127.0.0.1:11436", true, "managed"},
		{"managed", "http://localhost:11436", true, "managed"},
		{"managed", "http://[::1]:11436", true, "managed"},
		{"managed", "http://127.0.0.1:11436", false, "external"},  // remote mode: nothing to start
		{"managed", "http://192.168.1.9:11436", true, "external"}, // someone else's address
		{"managed", "http://127.0.0.1", true, "external"},         // no port to bind
		{"external", "http://127.0.0.1:11436", true, "external"},
		{"off", "http://127.0.0.1:11436", true, "off"},
	} {
		c.EmbedMode, c.EmbedURL = tc.mode, tc.url
		if got := EmbedRole(c, tc.engine); got != tc.want {
			t.Errorf("%s %s engine=%v: %s, want %s", tc.mode, tc.url, tc.engine, got, tc.want)
		}
	}
}
