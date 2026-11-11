package server

// MCP servers (1.8.0, #16): the routes. The servers themselves -- starting
// them, the protocol, tool lists, calls -- are internal/mcp; their tables in
// config.toml are internal/config/mcp.go.
//
// WHO MAY DO WHAT. An MCP server is a program that runs on this PC with the
// user's permissions, so this is the boundary that matters:
//
//   - Adding, changing, switching on or removing a server decides which
//     programs GobboNet starts. That is config.toml's rule (configfile.go):
//     a browser on this PC, on GobboNet's own page -- mayManage.
//   - Switching one off can only take something away, so any signed-in
//     device may, from GobboNet's own page. A phone that sees a server
//     misbehaving should not have to reach the PC to stop it.
//   - Listing tools and calling one: any signed-in device, from GobboNet's
//     own page. The chat on a phone can make the PC run a tool; that is the
//     feature. What stands between a character and a call is the page --
//     the tools ticked in the card, and the approval bar, which asks before
//     every call by default -- and here, the server must be switched on and
//     the tool must be one it lists. A call must carry an Origin that is
//     this server: a browser sends one on every POST, so no other website
//     can make a call, even on an install with no password, where no
//     session cookie stands in the way. CommonHeaders' CORS "*" would let
//     another site read the tool list, so that is same-origin too.
//
// Code that runs in the page itself -- a mod, or a card's code once you have
// switched it on -- has the page's access, this route included, as the card
// code comment in js/23-card-code.js says of everything else.

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"path/filepath"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
	"github.com/ElodineOfficial/GobboNet/internal/mcp"
	"github.com/ElodineOfficial/GobboNet/internal/version"
)

// mcpListWait is how long GET /mcp/tools waits for servers it had to start.
// One still starting after that is reported as starting, and the page asks
// again; npx can take a minute on a first run.
const mcpListWait = 15 * time.Second

// maxMCPCallBody bounds a call's body: toolArgsMaxKB's ceiling, and room.
const maxMCPCallBody = 1<<20 + 8<<10

const (
	mcpNotOnThisPC = "MCP servers are added, changed and switched on from GobboNet on the PC it runs on " +
		"(at http://localhost). From here you can switch one off."
	mcpNotOurPage = "MCP servers can only be used from GobboNet's own page, not from another website."
)

func newMCPManager(cfg config.Config) *mcp.Manager {
	opts := mcp.Options{
		LogDir:        filepath.Dir(cfg.LogFile()),
		ClientVersion: version.String(),
	}
	if cfg.Path != "" {
		opts.ConfigDir = filepath.Dir(cfg.Path)
	}
	m := mcp.NewManager(opts)
	m.Update(cfg.MCPServers, cfg.MCPCallTimeout())
	return m
}

// MCP is the server's MCP manager, for the startup banner.
func (s *Server) MCP() *mcp.Manager { return s.mcp }

func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request, path string) {
	switch path {
	case "/mcp/tools":
		s.handleMCPTools(w, r)
	case "/mcp/call":
		s.handleMCPCall(w, r)
	case "/mcp/servers":
		s.handleMCPServers(w, r)
	default:
		httpx.Error(w, r, http.StatusNotFound, "not found")
	}
}

// GET /mcp/tools[?refresh=1]: every server with its state and, once it is
// running, its tools. Enabled servers that are not running are started.
func (s *Server) handleMCPTools(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET only")
		return
	}
	if !sameOriginStrict(r, false) {
		httpx.Error(w, r, http.StatusForbidden, mcpNotOurPage)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), mcpListWait)
	defer cancel()
	servers := s.mcp.Tools(ctx, r.URL.Query().Get("refresh") == "1")
	httpx.WriteJSON(w, r, http.StatusOK, map[string]any{
		"servers":              servers,
		"call_timeout_seconds": int(s.mcp.CallTimeout() / time.Second),
	})
}

type mcpCallRequest struct {
	Server    string          `json:"server"`
	Tool      string          `json:"tool"`
	Arguments json.RawMessage `json:"arguments"`
	MaxChars  int             `json:"max_chars"`
}

// POST /mcp/call {server, tool, arguments, max_chars}: run one tool.
func (s *Server) handleMCPCall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		httpx.Error(w, r, http.StatusMethodNotAllowed, "POST only")
		return
	}
	if !sameOriginStrict(r, true) {
		httpx.Error(w, r, http.StatusForbidden, mcpNotOurPage)
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxMCPCallBody))
	if err != nil {
		httpx.Error(w, r, http.StatusRequestEntityTooLarge, "A tool call's arguments are limited to 1 MB.")
		return
	}
	var in mcpCallRequest
	if json.Unmarshal(raw, &in) != nil || in.Server == "" || in.Tool == "" {
		httpx.Error(w, r, http.StatusBadRequest, "Send the server, the tool and its arguments.")
		return
	}
	res, err := s.mcp.Call(r.Context(), in.Server, in.Tool, in.Arguments, in.MaxChars)
	if err != nil {
		status, kind := http.StatusBadGateway, mcp.KindUnavailable
		var e *mcp.Error
		if errors.As(err, &e) {
			kind = e.Kind
			switch e.Kind {
			case mcp.KindUnknownServer, mcp.KindUnknownTool:
				status = http.StatusNotFound
			case mcp.KindDisabled:
				status = http.StatusConflict
			case mcp.KindBadArgs:
				status = http.StatusBadRequest
			case mcp.KindTimeout:
				status = http.StatusGatewayTimeout
			case mcp.KindCancelled:
				status = http.StatusServiceUnavailable
			}
		}
		httpx.WriteJSON(w, r, status, map[string]any{"error": err.Error(), "kind": kind})
		return
	}
	httpx.WriteJSON(w, r, http.StatusOK, res)
}

// mcpServerView is one server as CONFIG > Advanced > MCP Servers shows it:
// its table, and how it is doing.
type mcpServerView struct {
	Name     string              `json:"name"`
	Command  string              `json:"command"`
	Args     []string            `json:"args"`
	Env      map[string]string   `json:"env"`
	Enabled  bool                `json:"enabled"`
	State    string              `json:"state"`
	Detail   string              `json:"detail,omitempty"`
	RetryIn  int                 `json:"retry_in_seconds,omitempty"`
	Server   *mcp.Implementation `json:"server,omitempty"`
	NumTools int                 `json:"tool_count"`
}

func (s *Server) mcpServersBody(r *http.Request) map[string]any {
	onPC := fromThisPC(r)
	cfgs, sts := s.mcp.List()
	views := make([]mcpServerView, len(cfgs))
	for i, c := range cfgs {
		st := sts[i]
		if !onPC && len(c.Env) > 0 {
			// The values can be tokens. A device that may not change a
			// server has no need of them; the names say what is set.
			masked := make(map[string]string, len(c.Env))
			for k := range c.Env {
				masked[k] = config.HiddenValue
			}
			c.Env = masked
		}
		if c.Args == nil {
			c.Args = []string{}
		}
		if c.Env == nil {
			c.Env = map[string]string{}
		}
		// The tools themselves are GET /mcp/tools'; this is the settings view.
		views[i] = mcpServerView{Name: c.Name, Command: c.Command, Args: c.Args, Env: c.Env, Enabled: c.Enabled,
			State: st.State, Detail: st.Detail, RetryIn: st.RetryIn, Server: st.Server, NumTools: st.NumTools}
	}
	body := map[string]any{
		"servers":              views,
		"can_manage":           onPC,
		"editable":             s.cfg.Path != "",
		"call_timeout_seconds": int(s.mcp.CallTimeout() / time.Second),
		"max_servers":          config.MaxMCPServers,
	}
	if !onPC {
		body["reason"] = mcpNotOnThisPC
	} else {
		body["log_dir"] = filepath.Dir(s.cfg.LogFile())
	}
	return body
}

// GET /mcp/servers: the tables and how each is doing.
// POST /mcp/servers {action, name, server}: change them.
func (s *Server) handleMCPServers(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		if !sameOriginStrict(r, false) {
			httpx.Error(w, r, http.StatusForbidden, mcpNotOurPage)
			return
		}
		httpx.WriteJSON(w, r, http.StatusOK, s.mcpServersBody(r))
		return
	case http.MethodPost:
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		httpx.Error(w, r, http.StatusRequestEntityTooLarge, "too large")
		return
	}
	var in struct {
		Action string            `json:"action"`
		Name   string            `json:"name"`
		Server *config.MCPServer `json:"server"`
	}
	if json.Unmarshal(raw, &in) != nil {
		httpx.Error(w, r, http.StatusBadRequest, "Send an action.")
		return
	}
	// Switching off is open to every signed-in device; everything else can
	// start a program, so it is this PC's alone.
	if in.Action == "disable" {
		if !sameOriginStrict(r, false) {
			httpx.Error(w, r, http.StatusForbidden, mcpNotOurPage)
			return
		}
	} else {
		if !fromThisPC(r) {
			httpx.Error(w, r, http.StatusForbidden, mcpNotOnThisPC)
			return
		}
		if !sameOriginStrict(r, false) {
			httpx.Error(w, r, http.StatusForbidden, mcpNotOurPage)
			return
		}
	}
	if s.cfg.Path == "" {
		httpx.Error(w, r, http.StatusConflict, "This server was started without a config file, so there is nowhere to keep MCP servers.")
		return
	}

	find := func(list []config.MCPServer, name string) int {
		for i, m := range list {
			if m.Name == name {
				return i
			}
		}
		return -1
	}
	notFound := errors.New("There is no MCP server called " + in.Name + ". Reload the list.")
	var change func([]config.MCPServer) ([]config.MCPServer, error)
	switch in.Action {
	case "save":
		if in.Server == nil {
			httpx.Error(w, r, http.StatusBadRequest, "Send the server to save.")
			return
		}
		m := *in.Server
		if err := m.Validate(); err != nil {
			httpx.Error(w, r, http.StatusBadRequest, err.Error())
			return
		}
		change = func(list []config.MCPServer) ([]config.MCPServer, error) {
			if other := find(list, m.Name); other >= 0 && m.Name != in.Name {
				return nil, errors.New("There is already an MCP server called " + m.Name + ".")
			}
			if in.Name == "" {
				if len(list) >= config.MaxMCPServers {
					return nil, errors.New("That is as many MCP servers as GobboNet keeps.")
				}
				return append(list, m), nil
			}
			i := find(list, in.Name)
			if i < 0 {
				return nil, notFound
			}
			list[i] = m
			return list, nil
		}
	case "enable", "disable":
		on := in.Action == "enable"
		change = func(list []config.MCPServer) ([]config.MCPServer, error) {
			i := find(list, in.Name)
			if i < 0 {
				return nil, notFound
			}
			list[i].Enabled = on
			return list, nil
		}
	case "remove":
		change = func(list []config.MCPServer) ([]config.MCPServer, error) {
			i := find(list, in.Name)
			if i < 0 {
				return nil, notFound
			}
			return append(list[:i], list[i+1:]...), nil
		}
	default:
		httpx.Error(w, r, http.StatusBadRequest, "The action must be save, enable, disable or remove.")
		return
	}

	saved, err := config.UpdateMCPServers(s.cfg.Path, change)
	if err != nil {
		status := http.StatusBadRequest
		if errors.Is(err, notFound) {
			status = http.StatusNotFound
		}
		httpx.Error(w, r, status, "Not saved: "+err.Error())
		return
	}
	s.mcp.Update(saved, 0)
	who := "this PC"
	if !fromThisPC(r) {
		who = "another device"
	}
	log.Printf("[mcp] %s %q from CONFIG on %s", in.Action, in.Name+serverName(in.Server, in.Name), who)
	httpx.WriteJSON(w, r, http.StatusOK, s.mcpServersBody(r))
}

// serverName adds a saved server's new name to the log line when it differs.
func serverName(m *config.MCPServer, old string) string {
	if m == nil || m.Name == old {
		return ""
	}
	if old == "" {
		return m.Name
	}
	return " -> " + m.Name
}

// applyMCPEdit puts a Config File editor save of the MCP settings into
// effect now: a server switched off there stops at once, as it does from the
// MCP box.
func (s *Server) applyMCPEdit(res config.EditResult) bool {
	changed := false
	for _, k := range res.Changed {
		if k == "mcp_server" || k == "mcp_call_timeout_seconds" {
			changed = true
		}
	}
	if changed {
		s.mcp.Update(res.New.MCPServers, res.New.MCPCallTimeout())
	}
	return changed
}
