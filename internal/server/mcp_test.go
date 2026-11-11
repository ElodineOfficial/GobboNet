package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/mcp"
	"github.com/ElodineOfficial/GobboNet/internal/mcp/mcptest"
)

// MCP servers (1.8.0, #16): who may do what over HTTP. The fake server these
// start is the test binary; see internal/mcp/mcptest.
func TestMain(m *testing.M) {
	mcptest.Main()
	os.Exit(m.Run())
}

const (
	pcHost    = "localhost:9066"
	pcOrigin  = "http://localhost:9066"
	lanHost   = "192.168.1.5:9066"
	lanOrigin = "http://192.168.1.5:9066"
	lanAddr   = "192.168.1.20:50000"
)

// fromPC and fromPhone are requests as the chat page sends them: a browser
// adds Origin to every POST and to a cross-site GET.
func fromPC(method, path, body string) cfReq {
	return cfReq{method: method, path: path, remote: local, host: pcHost, origin: pcOrigin, fetchSite: "same-origin", body: body}
}

func fromPhone(method, path, body string) cfReq {
	return cfReq{method: method, path: path, remote: lanAddr, host: lanHost, origin: lanOrigin, fetchSite: "same-origin", body: body}
}

func mcpServer(t *testing.T, timeoutSeconds int, tables ...config.MCPServer) (*Server, string) {
	t.Helper()
	s, cfg := newTestServer(t)
	s.mcp.Shutdown()
	body := "llm_url = \"http://127.0.0.1:1\"\n"
	if timeoutSeconds > 0 {
		body += "mcp_call_timeout_seconds = " + strconv.Itoa(timeoutSeconds) + "\n"
	}
	for _, m := range tables {
		body += "\n" + config.MCPServerTOML(m)
	}
	if err := os.WriteFile(cfg.Path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(cfg.Path)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MCPServers, cfg.MCPCallTimeoutSeconds = loaded.MCPServers, loaded.MCPCallTimeoutSeconds
	s.cfg = cfg
	s.mcp = newMCPManager(cfg)
	t.Cleanup(s.mcp.Shutdown)
	return s, cfg.Path
}

func action(a, name string, server *config.MCPServer) string {
	m := map[string]any{"action": a, "name": name}
	if server != nil {
		m["server"] = server
	}
	b, _ := json.Marshal(m)
	return string(b)
}

type serversBody struct {
	Servers []struct {
		Name    string
		Command string
		Args    []string
		Env     map[string]string
		Enabled bool
		State   string
		Detail  string
	}
	CanManage bool   `json:"can_manage"`
	Reason    string `json:"reason"`
}

func readServers(t *testing.T, w interface{ Bytes() []byte }) serversBody {
	t.Helper()
	var out serversBody
	if err := json.Unmarshal(w.Bytes(), &out); err != nil {
		t.Fatalf("%v: %s", err, w.Bytes())
	}
	return out
}

func TestMCPAddAndEnableOnlyFromThisPC(t *testing.T) {
	s, path := mcpServer(t, 0)
	fake := mcptest.Server(t, "fake", "normal", "", false)

	// A phone may not add one, nor switch one on, nor change or remove one.
	for _, body := range []string{action("save", "", &fake), action("enable", "fake", nil), action("remove", "fake", nil)} {
		w := fromPhone("POST", "/mcp/servers", body).do(s)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "on the PC it runs on") {
			t.Errorf("from a phone: %d %s", w.Code, w.Body)
		}
	}
	// Nor a reverse proxy on this PC forwarding someone else.
	proxied := fromPC("POST", "/mcp/servers", action("save", "", &fake))
	proxied.headers = map[string]string{"X-Forwarded-For": "203.0.113.9"}
	if w := proxied.do(s); w.Code != http.StatusForbidden {
		t.Errorf("forwarded: %d", w.Code)
	}
	if b, _ := os.ReadFile(path); strings.Contains(string(b), "mcp_server") {
		t.Fatal("a refused request changed config.toml")
	}

	// This PC may.
	if w := fromPC("POST", "/mcp/servers", action("save", "", &fake)).do(s); w.Code != http.StatusOK {
		t.Fatalf("add: %d %s", w.Code, w.Body)
	}
	if w := fromPC("POST", "/mcp/servers", action("enable", "fake", nil)).do(s); w.Code != http.StatusOK {
		t.Fatalf("enable: %d %s", w.Code, w.Body)
	}
	cfg, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.MCPServers) != 1 || !cfg.MCPServers[0].Enabled {
		t.Fatalf("file: %+v", cfg.MCPServers)
	}
	if st := s.mcp.Status(); len(st) != 1 || st[0].State != mcp.StateIdle {
		t.Errorf("the change did not reach the running servers: %+v", st)
	}
	// A second server with the same name is refused.
	if w := fromPC("POST", "/mcp/servers", action("save", "", &fake)).do(s); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "already") {
		t.Errorf("duplicate: %d %s", w.Code, w.Body)
	}
	// So is a table that would not load.
	bad := fake
	bad.Name = "Bad Name"
	if w := fromPC("POST", "/mcp/servers", action("save", "", &bad)).do(s); w.Code != http.StatusBadRequest {
		t.Errorf("invalid: %d", w.Code)
	}
}

func TestMCPAnyDeviceMaySwitchOneOff(t *testing.T) {
	s, path := mcpServer(t, 0, mcptest.Server(t, "fake", "normal", "", true))
	// Running, so switching it off has something to stop.
	if w := fromPhone("GET", "/mcp/tools", "").do(s); w.Code != http.StatusOK {
		t.Fatalf("tools: %d %s", w.Code, w.Body)
	}
	if st := s.mcp.Status(); st[0].State != mcp.StateReady {
		t.Fatalf("state %q (%s)", st[0].State, st[0].Detail)
	}

	// Not from another website, even with a session.
	cross := fromPhone("POST", "/mcp/servers", action("disable", "fake", nil))
	cross.origin, cross.fetchSite = "https://evil.example", "cross-site"
	if w := cross.do(s); w.Code != http.StatusForbidden {
		t.Errorf("cross-site disable: %d", w.Code)
	}

	w := fromPhone("POST", "/mcp/servers", action("disable", "fake", nil)).do(s)
	if w.Code != http.StatusOK {
		t.Fatalf("a phone switching one off: %d %s", w.Code, w.Body)
	}
	cfg, _ := config.Load(path)
	if cfg.MCPServers[0].Enabled {
		t.Error("the file still has it on")
	}
	if st := s.mcp.Status(); st[0].State != mcp.StateOff {
		t.Errorf("state after switching off: %q", st[0].State)
	}
	// And it is not started again by a call.
	if w := fromPhone("POST", "/mcp/call", `{"server":"fake","tool":"echo","arguments":{}}`).do(s); w.Code != http.StatusConflict {
		t.Errorf("a call to a switched-off server: %d %s", w.Code, w.Body)
	}
}

// Env values can be tokens: only this PC sees them.
func TestMCPEnvValuesStayOnThisPC(t *testing.T) {
	m := mcptest.Server(t, "fake", "normal", "", false)
	m.Env["NOTES_TOKEN"] = "tok-123"
	s, _ := mcpServer(t, 0, m)

	phone := fromPhone("GET", "/mcp/servers", "").do(s)
	if strings.Contains(phone.Body.String(), "tok-123") {
		t.Fatal("a phone was sent an env value")
	}
	b := readServers(t, phone.Body)
	if b.CanManage || b.Reason == "" || b.Servers[0].Env["NOTES_TOKEN"] != config.HiddenValue {
		t.Errorf("phone view: %+v", b)
	}
	pcView := readServers(t, fromPC("GET", "/mcp/servers", "").do(s).Body)
	if !pcView.CanManage || pcView.Servers[0].Env["NOTES_TOKEN"] != "tok-123" {
		t.Errorf("PC view: %+v", pcView)
	}
}

func TestMCPToolsAndCallOverHTTP(t *testing.T) {
	s, _ := mcpServer(t, 0, mcptest.Server(t, "fake", "normal", "", true), mcptest.Server(t, "off", "normal", "", false))

	w := fromPhone("GET", "/mcp/tools", "").do(s)
	if w.Code != http.StatusOK {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var tools struct {
		Servers []mcp.Status
		Timeout int `json:"call_timeout_seconds"`
	}
	json.Unmarshal(w.Body.Bytes(), &tools)
	if len(tools.Servers) != 2 || tools.Servers[0].State != mcp.StateReady || tools.Servers[0].NumTools == 0 {
		t.Fatalf("%+v", tools.Servers)
	}
	if tools.Servers[1].State != mcp.StateOff {
		t.Error("listing tools started a switched-off server")
	}
	if tools.Timeout != 30 {
		t.Errorf("call_timeout_seconds %d", tools.Timeout)
	}

	// A phone may call a tool: that is the feature.
	w = fromPhone("POST", "/mcp/call", `{"server":"fake","tool":"echo","arguments":{"text":"hi"}}`).do(s)
	if w.Code != http.StatusOK {
		t.Fatalf("call: %d %s", w.Code, w.Body)
	}
	var res mcp.Result
	json.Unmarshal(w.Body.Bytes(), &res)
	if res.Text != `echo: {"text":"hi"}` {
		t.Errorf("result: %+v", res)
	}

	for body, want := range map[string]int{
		`{"server":"fake","tool":"rm_rf","arguments":{}}`: http.StatusNotFound,
		`{"server":"nope","tool":"echo","arguments":{}}`:  http.StatusNotFound,
		`{"server":"off","tool":"echo","arguments":{}}`:   http.StatusConflict,
		`{"server":"fake","tool":"echo","arguments":"x"}`: http.StatusBadRequest,
		`{"tool":"echo"}`: http.StatusBadRequest,
		`{"server":"fake","tool":"fails","arguments":{}}`:               http.StatusOK, // isError is a result
		`{"server":"fake","tool":"big","arguments":{},"max_chars":600}`: http.StatusOK,
	} {
		w := fromPC("POST", "/mcp/call", body).do(s)
		if w.Code != want {
			t.Errorf("%s: %d, want %d (%s)", body, w.Code, want, w.Body)
		}
		if strings.Contains(body, "big") {
			json.Unmarshal(w.Body.Bytes(), &res)
			if !res.Truncated || len([]rune(res.Text)) != 600 {
				t.Errorf("max_chars: truncated=%v len=%d", res.Truncated, len([]rune(res.Text)))
			}
		}
	}
}

// No other website can list the tools or call one -- above all on an install
// with no password, where no session cookie stands in the way.
func TestMCPRefusesOtherSites(t *testing.T) {
	rec := filepath.Join(t.TempDir(), "record.txt")
	s, _ := mcpServer(t, 0, mcptest.Server(t, "fake", "normal", rec, true))

	call := `{"server":"fake","tool":"echo","arguments":{}}`
	for name, r := range map[string]cfReq{
		"cross-site Origin":   {method: "POST", path: "/mcp/call", remote: local, host: pcHost, origin: "https://evil.example", body: call},
		"cross-site fetch":    {method: "POST", path: "/mcp/call", remote: local, host: pcHost, origin: pcOrigin, fetchSite: "cross-site", body: call},
		"no Origin at all":    {method: "POST", path: "/mcp/call", remote: local, host: pcHost, body: call},
		"null Origin":         {method: "POST", path: "/mcp/call", remote: local, host: pcHost, origin: "null", body: call},
		"cross-site list":     {method: "GET", path: "/mcp/tools", remote: local, host: pcHost, origin: "https://evil.example"},
		"cross-site settings": {method: "GET", path: "/mcp/servers", remote: local, host: pcHost, origin: "https://evil.example"},
		"cross-site enable":   {method: "POST", path: "/mcp/servers", remote: local, host: pcHost, origin: "https://evil.example", body: action("enable", "fake", nil)},
		"same-site, not ours": {method: "POST", path: "/mcp/call", remote: local, host: pcHost, origin: "http://localhost:3000", fetchSite: "same-site", body: call},
	} {
		if w := r.do(s); w.Code != http.StatusForbidden {
			t.Errorf("%s: %d %s", name, w.Code, w.Body)
		}
	}
	// Nothing was started by any of it.
	if len(mcptest.Recorded(rec)) != 0 {
		t.Error("a refused request started the server")
	}
}

// The tool loop's limit: a call past mcp_call_timeout_seconds gets 504.
func TestMCPCallTimeoutOverHTTP(t *testing.T) {
	s, _ := mcpServer(t, 1, mcptest.Server(t, "fake", "normal", "", true))
	began := time.Now()
	w := fromPC("POST", "/mcp/call", `{"server":"fake","tool":"slow","arguments":{}}`).do(s)
	if w.Code != http.StatusGatewayTimeout || !strings.Contains(w.Body.String(), `"kind":"timeout"`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if time.Since(began) > 15*time.Second {
		t.Error("the timeout did not apply")
	}
}

// A save in CONFIG > config.toml that switches a server off stops it now,
// as the MCP box does.
func TestConfigFileEditAppliesMCPNow(t *testing.T) {
	s, _ := mcpServer(t, 0, mcptest.Server(t, "fake", "normal", "", true))
	fromPC("GET", "/mcp/tools", "").do(s)
	if st := s.mcp.Status(); st[0].State != mcp.StateReady {
		t.Fatalf("state %q", st[0].State)
	}
	open := openConfig(t, s)
	text := strings.Replace(open["text"].(string), "enabled = true", "enabled = false", 1)
	w := saveConfig(s, text, open["version"].(string))
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "applied_now") {
		t.Fatalf("save: %d %s", w.Code, w.Body)
	}
	if st := s.mcp.Status(); st[0].State != mcp.StateOff {
		t.Errorf("state after the save: %q", st[0].State)
	}
}

func TestMCPWithoutAConfigFile(t *testing.T) {
	s, _ := mcpServer(t, 0)
	s.cfg.Path = ""
	fake := mcptest.Server(t, "fake", "normal", "", false)
	if w := fromPC("POST", "/mcp/servers", action("save", "", &fake)).do(s); w.Code != http.StatusConflict {
		t.Errorf("%d %s", w.Code, w.Body)
	}
}
