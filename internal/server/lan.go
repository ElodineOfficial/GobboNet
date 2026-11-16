package server

// GET/POST /lan -- CONFIG's "Phone & Other Devices" box (roadmap 1.7.7 #7).
//
// GET says which addresses phones can use right now, which addresses this PC
// has that could be chosen instead, and what the config file will use on the
// next start. POST saves listen_host and listen_port to the config file.
//
// Nothing here rebinds the running server. A save applies on the next start,
// for the same reason /perf's "save for next start" does: changing the socket
// under the page that asked for it would cut the asker off mid-answer, and on
// a phone that is the one device that then cannot find the new address. The
// panel shows the new address before saving instead, so nobody is stranded.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"runtime"
	"strings"
	"syscall"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

func (s *Server) handleLAN(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		s.lanGet(w, r)
	case http.MethodPost:
		s.lanPost(w, r)
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
	}
}

func lanAddrJSON(a LANAddr, port int) map[string]any {
	m := map[string]any{
		"ip":        a.IP,
		"interface": a.Iface,
		"kind":      a.Kind.String(),
		"default":   a.Default,
	}
	if port > 0 {
		m["url"] = a.URL(port)
	}
	return m
}

// lanChoices is every address on this machine a user could pin: both families,
// best first, the same filtering the banner uses (no link-local, no loopback).
func lanChoices() []LANAddr {
	return LANAddrsFor("::")
}

func (s *Server) lanGet(w http.ResponseWriter, r *http.Request) {
	body := map[string]any{
		"os":       runtime.GOOS,
		"port_min": config.MinPanelPort,
		"port_max": config.MaxPanelPortFor(runtime.GOOS),
	}

	if b := s.Bind(); b != nil {
		running := map[string]any{
			"host":       b.Host,
			"port":       b.Port,
			"lan_access": b.LANReachable(),
			"local_url":  b.LocalURL(),
		}
		if b.Loopback != "" {
			running["also_loopback"] = b.Loopback
		}
		if b.LoopbackErr != nil {
			running["loopback_error"] = b.LoopbackErr.Error()
		}
		if b.FellBack {
			running["fell_back"] = true
			running["bind_error"] = b.WideErr.Error()
		}
		body["running"] = running

		addrs := []map[string]any{}
		if b.LANReachable() {
			for _, a := range LANAddrsFor(b.Host) {
				addrs = append(addrs, lanAddrJSON(a, b.Port))
			}
		}
		body["addresses"] = addrs
	}

	choices := []map[string]any{}
	for _, a := range lanChoices() {
		choices = append(choices, lanAddrJSON(a, 0))
	}
	body["choices"] = choices

	if saved, err := config.ReadListen(s.cfg.Path); err == nil {
		body["saved"] = map[string]any{"host": saved.Host, "port": saved.Port}
	} else {
		body["saved_error"] = err.Error()
	}
	if env := config.ListenEnvOverrides(); len(env) > 0 {
		body["env_overrides"] = env
	}

	httpx.WriteJSON(w, r, http.StatusOK, body)
}

type lanRequest struct {
	Host *string `json:"host"`
	Port *int    `json:"port"`
}

// sameOriginOrNone is the one extra check this route makes over its
// neighbours. Everything else here relies on the password (see CommonHeaders);
// but an install with no password is allowed, and this route is the one that
// can widen who reaches the server. A page on some other site must not be able
// to switch "this PC only" to "every address". A browser always sends Origin
// on a cross-site POST, so a present Origin has to be this server; tools such
// as curl send none, and are let through as they are everywhere else.
func sameOriginOrNone(r *http.Request) bool {
	o := r.Header.Get("Origin")
	if o == "" {
		return true
	}
	u, err := url.Parse(o)
	if err != nil || u.Host == "" {
		return false
	}
	return strings.EqualFold(u.Host, r.Host)
}

// validLANHost accepts the wildcards, loopback, or an address this machine
// actually has. Anything else would fail to bind on the next start -- and fall
// back to this-PC-only, which is safe but not what anyone asked for.
func validLANHost(host string) bool {
	switch host {
	// "" and "localhost" are here because a config file may already say them,
	// and saving only a new port must not be refused over the address.
	case "0.0.0.0", "::", "", "127.0.0.1", "::1", "localhost":
		return true
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	for _, a := range lanChoices() {
		if net.ParseIP(a.IP).Equal(ip) {
			return true
		}
	}
	return false
}

func (s *Server) lanPost(w http.ResponseWriter, r *http.Request) {
	if !sameOriginOrNone(r) {
		httpx.Error(w, r, http.StatusForbidden, "This setting can only be changed from GobboNet's own page.")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 16<<10))
	if err != nil {
		httpx.ErrorDetail(w, r, http.StatusBadRequest, "could not read body", err.Error())
		return
	}
	var req lanRequest
	if err := json.Unmarshal(raw, &req); err != nil || req.Host == nil || req.Port == nil {
		httpx.Error(w, r, http.StatusBadRequest, "Send both host and port.")
		return
	}
	host, port := strings.TrimSpace(*req.Host), *req.Port

	if !validLANHost(host) {
		httpx.Error(w, r, http.StatusBadRequest,
			fmt.Sprintf("%s is not an address this PC has. Pick one from the list, or Automatic.", host))
		return
	}
	if hi := config.MaxPanelPortFor(runtime.GOOS); port < config.MinPanelPort || port > hi {
		httpx.Error(w, r, http.StatusBadRequest,
			fmt.Sprintf("The port must be between %d and %d.", config.MinPanelPort, hi))
		return
	}
	if s.cfg.EnginePorts()[port] {
		httpx.Error(w, r, http.StatusBadRequest,
			fmt.Sprintf("Port %d belongs to the AI engine. Pick another.", port))
		return
	}

	// A different port is tried before it is saved. The next start would
	// otherwise fail on it, and this page -- the place the user would fix it
	// from -- would be on the far side of that failure. The port in use now
	// is not tried: we are the ones holding it.
	if b := s.Bind(); b == nil || port != b.Port {
		if err := probePort(host, port); err != nil {
			httpx.ErrorDetail(w, r, http.StatusConflict, portProbeMessage(port, err), err.Error())
			return
		}
	}

	if err := config.Set(s.cfg.Path, "listen_host", host); err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "could not write "+s.cfg.Path, err.Error())
		return
	}
	if err := config.Set(s.cfg.Path, "listen_port", fmt.Sprintf("%d", port)); err != nil {
		httpx.ErrorDetail(w, r, http.StatusInternalServerError, "could not write "+s.cfg.Path, err.Error())
		return
	}

	resp := map[string]any{
		"ok":    true,
		"saved": map[string]any{"host": host, "port": port},
	}
	// Windows: launch.bat takes the port from .gobbonet-port and writes it
	// into the config before starting the server, so a port saved only to the
	// config would be put back on the next launch. Writing the sidecar too
	// makes the launcher carry the new one forward. A no-op elsewhere.
	if err := config.WritePortFile(port); err != nil {
		resp["port_file_error"] = err.Error()
	}
	if env := config.ListenEnvOverrides(); len(env) > 0 {
		resp["env_overrides"] = env
	}
	log.Printf("[lan] saved for next start: listen_host=%s listen_port=%d", host, port)
	httpx.WriteJSON(w, r, http.StatusOK, resp)
}

// probePort tries the address the next start will bind. A wildcard is tried
// as itself; a pinned address is tried as itself and on loopback, since both
// are bound (see Bind.Loopback).
var probePort = func(host string, port int) error {
	hosts := []string{host}
	if pinnedHost(host) {
		hosts = append(hosts, loopbackFor(host))
	}
	for _, h := range hosts {
		ln, err := net.Listen("tcp", net.JoinHostPort(h, fmt.Sprintf("%d", port)))
		if err != nil {
			return err
		}
		ln.Close()
	}
	return nil
}

func portProbeMessage(port int, err error) string {
	if errors.Is(err, syscall.EADDRINUSE) || isWSAErr(err, 10048) {
		return fmt.Sprintf("Port %d is being used by another program right now, so GobboNet could not start on it. Pick another.", port)
	}
	if errors.Is(err, syscall.EACCES) || isWSAErr(err, 10013) {
		if runtime.GOOS != "windows" {
			return fmt.Sprintf("This Mac or PC will not let GobboNet use port %d. Pick another.", port)
		}
		return fmt.Sprintf("This PC will not let GobboNet use port %d (Windows reserves some ranges for Hyper-V, WSL and Docker). Pick another.", port)
	}
	return fmt.Sprintf("GobboNet could not open port %d to check it. Pick another.", port)
}

func isWSAErr(err error, code uintptr) bool {
	var errno syscall.Errno
	return errors.As(err, &errno) && uintptr(errno) == code
}
