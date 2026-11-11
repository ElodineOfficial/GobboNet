package server

import (
	"net"
	"net/url"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

// The embedding server, as the page sees it (1.8.0, #15).

// embedWakeWait bounds how long an /embed request waits for a stood-down
// embedding server to come back. It loads in a second or two on a CPU; past
// this the request goes through anyway and the page falls back to tags.
const embedWakeWait = 20 * time.Second

// AttachEmbedder hands the server a managed embedding server: /health-fileserver
// reports it, an /embed request wakes it from stand-down, Shutdown stops it,
// and the chat model's stand-down and wake carry it along.
func (s *Server) AttachEmbedder(e *supervisor.Embedder) {
	s.embed = e
	if e != nil && s.sup != nil {
		s.sup.OnStandDown = e.StandDown
		s.sup.OnWake = e.Wake
	}
}

// embedState is what /health-fileserver says under "embed", and why.
func (s *Server) embedState() (state, detail string) {
	if s.embed != nil {
		st := s.embed.Status()
		return st.State, st.Detail
	}
	if role := EmbedRole(s.cfg, s.sup != nil); role != "managed" {
		return role, ""
	}
	// Managed, but nothing attached: a server built without one (a test
	// harness). Nothing answers /embed from here.
	return supervisor.EmbedOff, ""
}

// EmbedRole is who runs the embedding server for this config: "off", "managed"
// (this program, with a local engine and an embed_url on this PC), or
// "external". A managed setting with no local engine, or an embed_url that is
// not on this PC, falls back to external: there is nothing here to start, or
// it would be someone else's address.
func EmbedRole(cfg config.Config, localEngine bool) string {
	switch cfg.EmbedMode {
	case config.EmbedOff:
		return supervisor.EmbedOff
	case config.EmbedExternal:
		return supervisor.EmbedExternal
	}
	if !localEngine || cfg.ServerExe == "" || !embedURLIsLocal(cfg.EmbedURL) {
		return supervisor.EmbedExternal
	}
	return "managed"
}

func embedURLIsLocal(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Port() == "" {
		return false
	}
	h := u.Hostname()
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}
