package server

// CONFIG > config.toml: read and save the server's config file from the chat
// page, so nobody has to go looking for it. The file handling, the hidden
// secrets and the checks a save must pass are in internal/config/editfile.go.
//
// ONLY FROM THIS PC. config.toml decides which programs GobboNet starts, which
// folders it serves and reads, and where it sends requests. A browser on the
// PC that runs GobboNet can do nothing here that its user could not do by
// opening the file. Anywhere else -- a phone, another computer, or someone
// holding a session cookie read off the LAN -- it would be a way to run
// programs on this PC. So:
//
//   - the request must come from loopback AND name a loopback host, so a
//     reverse proxy on this PC forwarding remote visitors does not count;
//   - any proxy forwarding header disqualifies it for the same reason;
//   - a browser request must be same-origin: a page on another site cannot
//     read the file (every response here is CORS "*") or save it.
//
// Anyone else is told where to open it, and gets nothing of the file.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"runtime"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

// fromThisPC reports whether r comes from a browser on the PC running GobboNet.
func fromThisPC(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil || !addr.Unmap().IsLoopback() {
		return false
	}
	for _, h := range []string{"X-Forwarded-For", "X-Forwarded-Host", "Forwarded", "X-Real-Ip"} {
		if r.Header.Get(h) != "" {
			return false
		}
	}
	name := r.Host
	if h, _, err := net.SplitHostPort(name); err == nil {
		name = h
	}
	return isLoopbackHost(strings.ToLower(strings.Trim(name, "[]")))
}

// sameOriginStrict is sameOriginOrNone without the "none": a browser always
// sends Origin on a fetch from another site, and Sec-Fetch-Site says where a
// request came from even when Origin is left off.
func sameOriginStrict(r *http.Request, requireOrigin bool) bool {
	if s := r.Header.Get("Sec-Fetch-Site"); s != "" && s != "same-origin" && s != "none" {
		return false
	}
	o := r.Header.Get("Origin")
	if o == "" {
		return !requireOrigin
	}
	u, err := url.Parse(o)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && strings.EqualFold(u.Host, r.Host)
}

func (s *Server) configFileElsewhere(w http.ResponseWriter, r *http.Request) {
	port := s.cfg.ListenPort
	if b := s.Bind(); b != nil {
		port = b.Port
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"editable": false,
		"reason": fmt.Sprintf("config.toml can only be opened from the PC GobboNet runs on, at http://127.0.0.1:%d. "+
			"It decides which programs GobboNet starts, so it is not offered to other devices.", port),
	})
}

func (s *Server) handleConfigFile(w http.ResponseWriter, r *http.Request) {
	restore := r.URL.Path == "/config/file/restore"
	switch {
	case restore && r.Method != http.MethodPost,
		!restore && r.Method != http.MethodGet && r.Method != http.MethodHead && r.Method != http.MethodPost:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	write := r.Method == http.MethodPost
	if !sameOriginStrict(r, write) {
		httpx.Error(w, r, http.StatusForbidden, "Open config.toml from GobboNet's own CONFIG panel.")
		return
	}
	if !fromThisPC(r) {
		if write {
			httpx.Error(w, r, http.StatusForbidden, "config.toml can only be changed from the PC GobboNet runs on.")
			return
		}
		s.configFileElsewhere(w, r)
		return
	}
	if s.cfg.Path == "" {
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
			"editable": false,
			"reason":   "This server was started without a config file, so there is nothing to edit.",
		})
		return
	}
	if !write {
		s.configFileGet(w, r)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*config.MaxEditBytes+4<<10))
	if err != nil {
		httpx.Error(w, r, http.StatusRequestEntityTooLarge, fmt.Sprintf("config.toml is limited to %d KB here.", config.MaxEditBytes>>10))
		return
	}
	var in struct {
		Text    *string `json:"text"`
		Version string  `json:"version"`
	}
	if json.Unmarshal(raw, &in) != nil || in.Version == "" || (!restore && in.Text == nil) {
		httpx.Error(w, r, http.StatusBadRequest, "Send the file's text and the version it was opened at.")
		return
	}
	var res config.EditResult
	if restore {
		res, err = config.PrepareRestore(s.cfg.Path, in.Version)
	} else {
		res, err = config.PrepareEdit(s.cfg.Path, *in.Text, in.Version)
	}
	if err == nil {
		err = s.checkListenEdit(res)
	}
	if err == nil {
		res, err = config.CommitEdit(s.cfg.Path, in.Version, res)
	}
	switch {
	case errors.Is(err, config.ErrEditConflict):
		httpx.Error(w, r, http.StatusConflict, "config.toml changed since you opened it (another panel, the launcher, or a sign-in may have saved it). Reload it and make your change again.")
		return
	case err != nil:
		httpx.Error(w, r, http.StatusBadRequest, "Not saved: "+err.Error())
		return
	}

	out := map[string]any{
		"ok": true, "changed": res.Changed, "warnings": res.Warnings,
		"version": res.Version, "has_backup": true, "restored": restore,
	}
	// Windows: launch.bat carries the port forward from .gobbonet-port, as
	// lan.go explains. A port saved here must not be put back on next launch.
	if res.Old.ListenPort != res.New.ListenPort {
		if err := config.WritePortFile(res.New.ListenPort); err != nil {
			out["port_file_error"] = err.Error()
		}
	}
	what := "saved"
	if restore {
		what = "put back the previous version"
	}
	log.Printf("[config] %s from CONFIG: %s (changed: %s); applies on the next start", s.cfg.Path, what, strings.Join(res.Changed, ", "))
	// MCP servers are the exception: one switched off here stops now.
	if s.applyMCPEdit(res) {
		out["applied_now"] = []string{"mcp_server", "mcp_call_timeout_seconds"}
		log.Printf("[config] the MCP server settings apply now")
	}
	httpx.WriteJSON(w, r, http.StatusOK, out)
}

func (s *Server) configFileGet(w http.ResponseWriter, r *http.Request) {
	view, err := config.ReadForEdit(s.cfg.Path)
	if err != nil {
		msg := err.Error()
		if os.IsNotExist(err) {
			msg = "config.toml is not where this server loaded it from any more: " + s.cfg.Path
		}
		httpx.WriteJSON(w, r, http.StatusOK, map[string]any{"editable": false, "path": s.cfg.Path, "reason": msg})
		return
	}
	var env []string
	for _, key := range []string{"LLM_URL", "SEARCH_URL", "EMBED_URL", "LLM_API_KEY", "LISTEN_HOST", "LISTEN_PORT",
		"SERVER_EXE", "MODEL_DIR", "WEB_ROOT", "DATA_DIR", "CTX_SIZE", "GPU_LAYERS", "KV_CACHE_TYPE", "ACCESS_SECRET"} {
		for _, prefix := range []string{"GOBBONET_", "GEMMA_"} {
			if os.Getenv(prefix+key) != "" {
				env = append(env, prefix+key)
				break
			}
		}
	}
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"editable":       true,
		"path":           s.cfg.Path,
		"text":           view.Text,
		"version":        view.Version,
		"hidden":         view.Hidden,
		"has_backup":     view.HasBackup,
		"perf_overrides": s.cfg.PerfOverridden,
		"env_overrides":  env,
	})
}

// checkListenEdit applies CONFIG > Phone & Other Devices' rules to a changed
// listen address or port, so the file cannot be saved with one the next start
// would fail to bind -- this page being on the far side of that failure.
func (s *Server) checkListenEdit(res config.EditResult) error {
	if res.Old.ListenHost == res.New.ListenHost && res.Old.ListenPort == res.New.ListenPort {
		return nil
	}
	host, port := strings.TrimSpace(res.New.ListenHost), res.New.ListenPort
	if !validLANHost(host) {
		return fmt.Errorf("listen_host %q is not an address this PC has. Use 0.0.0.0, 127.0.0.1, or one listed under Phone & Other Devices", host)
	}
	if res.Old.ListenPort != port {
		if hi := config.MaxPanelPortFor(runtime.GOOS); port < config.MinPanelPort || port > hi {
			return fmt.Errorf("listen_port must be between %d and %d", config.MinPanelPort, hi)
		}
		if res.New.EnginePorts()[port] {
			return fmt.Errorf("listen_port %d belongs to the AI engine. Pick another", port)
		}
	}
	if b := s.Bind(); b == nil || port != b.Port {
		if err := probePort(host, port); err != nil {
			return fmt.Errorf("%s", portProbeMessage(port, err))
		}
	}
	return nil
}
