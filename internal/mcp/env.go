package mcp

import (
	"sort"
	"strings"
)

// What an MCP server inherits from GobboNet's environment: enough to run, and
// nothing else. The lists are the official MCP SDKs' (getDefaultEnvironment),
// plus the locale and temp-folder names a program needs to print and write,
// on Windows what cmd.exe needs to run an npx.cmd, and everywhere the proxy
// and certificate settings that say how this machine reaches the internet.
// The most common way to run a server is `npx -y` or `uvx`, which fetch it
// first; behind a company proxy, without these, that fetch fails with a
// certificate error that says nothing about why.
//
// Never everything. GobboNet's environment can hold GOBBONET_ACCESS_SECRET,
// GOBBONET_LLM_API_KEY and whatever else the person who started it had set;
// a tool server has no business with any of it. What a server needs beyond
// this list goes in its own env table, where it can be seen.
var (
	inheritUnix = append([]string{
		"HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER",
		"LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "XDG_RUNTIME_DIR",
		// Unix tools read both spellings.
		"http_proxy", "https_proxy", "no_proxy", "all_proxy",
	}, inheritNetwork...)
	inheritWindows = append([]string{
		"APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH",
		"PROCESSOR_ARCHITECTURE", "PROGRAMFILES", "SYSTEMDRIVE", "SYSTEMROOT",
		"TEMP", "TMP", "USERNAME", "USERPROFILE",
		"COMSPEC", "PATHEXT", "WINDIR",
	}, inheritNetwork...)
	inheritNetwork = []string{
		"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
		"NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
	}
)

// buildEnv is the environment a server starts with: the inherited names
// above, from environ, then extra (its env table) over them. On Windows
// names are matched without regard to case, as Windows matches them.
func buildEnv(goos string, environ []string, extra map[string]string) []string {
	fold := goos == "windows"
	norm := func(k string) string {
		if fold {
			return strings.ToUpper(k)
		}
		return k
	}
	allowed := map[string]bool{}
	list := inheritUnix
	if goos == "windows" {
		list = inheritWindows
	}
	for _, k := range list {
		allowed[norm(k)] = true
	}

	type kv struct{ k, v string }
	out := map[string]kv{}
	for _, e := range environ {
		k, v, ok := strings.Cut(e, "=")
		if !ok || k == "" || !allowed[norm(k)] {
			continue
		}
		// A bash function exported into the environment. The SDKs skip
		// these too: they are code, not settings.
		if strings.HasPrefix(v, "()") {
			continue
		}
		out[norm(k)] = kv{k, v}
	}
	for k, v := range extra {
		out[norm(k)] = kv{k, v}
	}
	keys := make([]string, 0, len(out))
	for k := range out {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	env := make([]string, 0, len(keys))
	for _, k := range keys {
		env = append(env, out[k].k+"="+out[k].v)
	}
	return env
}
