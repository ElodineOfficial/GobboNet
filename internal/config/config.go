// Package config resolves everything the server needs at startup from a single
// TOML file, shared with launch.bat and launch.sh.
//
// This replaces three scattered sources that used to disagree with each other:
// the CONFIG block at the top of launch.bat, the Get-EnvOrDefault block at the
// top of fileserver.ps1, and the GEMMA_* environment variables launch.bat
// exported to bridge the two. One file, one parser, one source of truth.
//
// Discovery order (first hit wins):
//
//	--config <path>
//	$GOBBONET_CONFIG              ($GEMMA_CONFIG accepted, with a warning)
//	$XDG_CONFIG_HOME/gobbonet/config.toml
//	~/.config/gobbonet/config.toml
//	./config.toml                 (matches the Windows layout, next to launch.bat)
//
// Data — state backup, downloaded models, logs — lives under
// $XDG_DATA_HOME/gobbonet (~/.local/share/gobbonet). Config is not data; the
// two directories are deliberately separate.
package config

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"

	"github.com/jmccardle/gobbonet/internal/catalog"
)

// Mode is what the server does about llama.cpp: supervise it, or just proxy to
// it. Everything else — auth, state sync, jobs, static files, the proxy itself
// — behaves identically in both.
type Mode string

const (
	// ModeLocal: we own the llama-server process, so hot-swap works and model
	// metadata comes from GGUF headers on disk.
	ModeLocal Mode = "local"
	// ModeRemote: llama.cpp is somebody else's problem. Hot-swap answers 503
	// and model metadata comes from the upstream's /props.
	ModeRemote Mode = "remote"
)

// Defaults. These are also the values written into a freshly generated
// config.toml, so the file documents itself.
const (
	// 11437, not 11434: 11434 is Ollama's default port, and llama.cpp sitting on
	// it meant that on any machine with Ollama installed the launcher found
	// *something* answering, decided llama-server was already up, skipped
	// starting its own, then found nothing healthy and restarted — a loop caused
	// entirely by sharing a well-known port. Upstream moved in 1.5.8; matching
	// it keeps one llama.cpp serving whichever server is in front of it.
	DefaultLLMURL = "http://127.0.0.1:11437"
	// The web-search API itself, not a relay in front of it. Upstream 1.6.0
	// deleted the relay: it was a hidden-window PowerShell started with
	// -EncodedCommand, binding 11435 and forwarding authenticated requests to
	// this same host. Nothing in the Go port ever started that process, so
	// pointing at 11435 meant /search answered 502 on every install unless the
	// user ran the launcher's relay by hand.
	//
	// The one thing the relay did that a plain reverse proxy does not is answer
	// /health locally; the client checks that before every search. Server.go
	// answers it instead — see handleSearch.
	DefaultSearchURL  = "https://ollama.com/api"
	DefaultEmbedURL   = "http://127.0.0.1:11436"
	DefaultListenHost = "0.0.0.0"
	// 9066 ("gobb" on a keypad), not 8080. 8080 is the most contended port on a
	// developer machine — Tomcat, Jenkins and half of every tutorial want it —
	// and on Windows the dynamic ranges Hyper-V, WSL2 and Docker Desktop reserve
	// can swallow it outright, which presents as a bind failure netstat cannot
	// explain. Existing installs are unaffected: a config.toml written before
	// this change carries an explicit listen_port and keeps it.
	DefaultListenPort = 9066

	DefaultCtxSize     = 16384
	DefaultGPULayers   = 99
	DefaultKVCacheType = "q8_0"

	DefaultSessionTTLHours = 12
	// One generation at a time. The app has always worked that way and
	// llama-server is launched with a single slot, so a cap of 4 only ever
	// bought a backlog it could not serve — press Stop, send again, and the new
	// request queued behind a generation nobody was reading. Past the cap the
	// jobs manager now supersedes rather than refusing; see internal/jobs.
	DefaultJobMaxConcurrent = 1
	DefaultJobMaxAgeHours   = 48
)

// Config is the parsed config.toml. Field tags are the TOML keys; the launchers
// write these names and `gobbonet config set` edits them in place.
type Config struct {
	// --- Upstreams ---------------------------------------------------------
	LLMURL    string `toml:"llm_url"`
	SearchURL string `toml:"search_url"`
	EmbedURL  string `toml:"embed_url"`

	// LLMAPIKey is sent upstream and never exposed to the browser.
	// LLMAPIKeyFile is read at startup and wins over the inline value, so the
	// secret can live outside a file that the launchers rewrite.
	LLMAPIKey     string `toml:"llm_api_key"`
	LLMAPIKeyFile string `toml:"llm_api_key_file"`

	// --- Listener ----------------------------------------------------------
	ListenHost string `toml:"listen_host"`
	ListenPort int    `toml:"listen_port"`

	// AllowedHosts extends the Host-header allowlist with extra names.
	// Empty is not "allow everything" — see HostAllowed for the default policy,
	// which permits IP literals and localhost but refuses unknown DNS names so a
	// rebinding attack can't reach a server bound to 0.0.0.0.
	AllowedHosts []string `toml:"allowed_hosts"`

	// --- Local backend (hot-swap) ------------------------------------------
	ServerExe   string `toml:"server_exe"`
	GPULayers   int    `toml:"gpu_layers"`
	CtxSize     int    `toml:"ctx_size"`
	KVCacheType string `toml:"kv_cache_type"`

	// --- Directories -------------------------------------------------------
	ModelDir string `toml:"model_dir"`
	WebRoot  string `toml:"web_root"`
	DataDir  string `toml:"data_dir"`

	// --- Access control ----------------------------------------------------
	// AccessSecret is either a legacy "salt:hash" SHA-256 pair or an Argon2id
	// PHC string. See internal/auth: a legacy secret is verified as-is and
	// rewritten as Argon2id on the next successful login.
	AccessSecret string `toml:"access_secret"`

	// --- Model catalogue ----------------------------------------------------
	// ModelCatalogURL is the published download catalogue. Fetched by this
	// binary, never by the browser, as a plain GET with no parameters and
	// nothing identifying — see internal/catalog/fetch.go.
	//
	// ModelCatalogRemote switches that fetch off entirely. When false, nothing
	// is requested and the list comes from the cache or the shipped
	// models.ini. This is the setting the config panel exposes.
	//
	// A plain bool rather than a pointer: Load seeds from Default() before
	// decoding, so an absent key keeps the default (true) and an explicit
	// `false` still wins. A *bool would distinguish those too, but it would
	// break `config set`, whose formatValue quotes anything that is not a
	// plain Int, Bool or Slice.
	ModelCatalogURL    string `toml:"model_catalog_url"`
	ModelCatalogRemote bool   `toml:"model_catalog_remote"`

	// --- Chat template overrides -------------------------------------------
	ChatTemplateName string `toml:"chat_template_name"`
	ChatTemplateFile string `toml:"chat_template_file"`

	// --- Sessions and jobs -------------------------------------------------
	SessionTTLHours  int `toml:"session_ttl_hours"`
	JobMaxConcurrent int `toml:"job_max_concurrent"`
	JobMaxAgeHours   int `toml:"job_max_age_hours"`

	// --- Not from the file -------------------------------------------------
	// AutoCtxSize, AutoGPULayers and AutoKVCacheType are what config.toml said
	// before perf.toml was overlaid — the hardware-detected baseline the
	// settings panel offers to reset to. Only ApplyPerf sets them; without that
	// call they are zero and the three live values above are the file's.
	AutoCtxSize     int    `toml:"-"`
	AutoGPULayers   int    `toml:"-"`
	AutoKVCacheType string `toml:"-"`
	// PerfOverridden reports whether a perf.toml was found and applied.
	PerfOverridden bool `toml:"-"`

	// Path is where this config was loaded from; `config set` writes back here
	// and set-password persists the new secret here.
	Path string `toml:"-"`
	// RequireAuth is cleared by --no-auth for a loopback-only run.
	RequireAuth bool `toml:"-"`
	// Deferred holds misconfigurations that are fatal to running a server but
	// irrelevant to inspecting the config. Load records them; Runnable reports
	// them. Keeps `config get` working on a config that `serve` would reject.
	Deferred []error `toml:"-"`
}

// Runnable reports the first misconfiguration that makes this config unfit to
// serve with. Call it from every command that actually starts doing work.
func (c *Config) Runnable() error {
	if len(c.Deferred) > 0 {
		return c.Deferred[0]
	}
	return nil
}

// Default returns the configuration used when no file exists yet. It is also
// what WriteDefault serialises, so the generated file and the in-memory
// defaults can never drift.
func Default() Config {
	return Config{
		LLMURL:      DefaultLLMURL,
		SearchURL:   DefaultSearchURL,
		EmbedURL:    DefaultEmbedURL,
		ListenHost:  DefaultListenHost,
		ListenPort:  DefaultListenPort,
		GPULayers:   DefaultGPULayers,
		CtxSize:     DefaultCtxSize,
		KVCacheType: DefaultKVCacheType,
		// Left empty on purpose: normalise() then resolves it to
		// <data_dir>/models, i.e. the XDG data directory. A literal "./models"
		// here would resolve against the *config* directory and put multi-
		// gigabyte GGUFs under ~/.config, which is what the XDG split exists to
		// prevent. A portable install opts back in by setting a relative path.
		ModelDir:         "",
		SessionTTLHours:  DefaultSessionTTLHours,
		JobMaxConcurrent: DefaultJobMaxConcurrent,
		JobMaxAgeHours:   DefaultJobMaxAgeHours,
		RequireAuth:      true,
		// The catalogue fetch is on by default. It is the only thing besides
		// web search that leaves the machine, it is a plain GET of a static
		// file with nothing identifying attached, and off by default would
		// mean most users never see a model added after their install. The
		// config panel makes it one click to turn off.
		ModelCatalogURL:    catalog.DefaultURL,
		ModelCatalogRemote: true,
	}
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil && h != "" {
		return h
	}
	return "."
}

// ConfigDir is $XDG_CONFIG_HOME/gobbonet, falling back to ~/.config/gobbonet.
func ConfigDir() string {
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "gobbonet")
	}
	return filepath.Join(homeDir(), ".config", "gobbonet")
}

// DataDir is $XDG_DATA_HOME/gobbonet, falling back to ~/.local/share/gobbonet.
// State, models and logs live here — never in ConfigDir.
func DataDir() string {
	if x := os.Getenv("XDG_DATA_HOME"); x != "" {
		return filepath.Join(x, "gobbonet")
	}
	return filepath.Join(homeDir(), ".local", "share", "gobbonet")
}

// DefaultPath is where a config is written when none was found.
func DefaultPath() string { return filepath.Join(ConfigDir(), "config.toml") }

// Discover returns the config path to use, and whether it already exists.
// An explicit path (flag or env) is returned even when missing — the caller
// reports that as an error rather than silently writing a new file somewhere
// the user didn't ask for.
func Discover(flagPath string) (path string, explicit bool) {
	if flagPath != "" {
		return flagPath, true
	}
	if p := os.Getenv("GOBBONET_CONFIG"); p != "" {
		return p, true
	}
	if p := os.Getenv("GEMMA_CONFIG"); p != "" {
		warnDeprecated("GEMMA_CONFIG", "GOBBONET_CONFIG")
		return p, true
	}
	if p := DefaultPath(); fileExists(p) {
		return p, false
	}
	if p := "config.toml"; fileExists(p) {
		abs, err := filepath.Abs(p)
		if err != nil {
			return p, false
		}
		return abs, false
	}
	return DefaultPath(), false
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

// ErrNotFound means no config file exists at the resolved path. The caller is
// expected to write the commented default, tell the user, and exit — not to
// carry on with in-memory defaults, which would leave no artifact to edit.
var ErrNotFound = errors.New("config file not found")

// Load reads and normalises the config at path. Missing file yields ErrNotFound.
func Load(path string) (Config, error) {
	cfg := Default()
	cfg.Path = path

	if !fileExists(path) {
		return cfg, ErrNotFound
	}

	md, err := toml.DecodeFile(path, &cfg)
	if err != nil {
		return cfg, fmt.Errorf("parse %s: %w", path, err)
	}
	// An unrecognised key is almost always a typo in a hand-edited file, and
	// silently ignoring it means the setting the user thought they changed
	// never took effect. Say so rather than let it pass.
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		keys := make([]string, 0, len(undecoded))
		for _, k := range undecoded {
			keys = append(keys, k.String())
		}
		return cfg, fmt.Errorf("%s: unknown setting(s): %s", path, strings.Join(keys, ", "))
	}

	cfg.applyEnv()
	if err := cfg.normalise(); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// applyEnv lets environment variables override the file. GOBBONET_* is the
// current spelling; the GEMMA_* names fileserver.ps1 read are still honoured so
// an existing Windows-side setup carries over, but each one warns once.
func (c *Config) applyEnv() {
	envStr := func(key string, dst *string) {
		if v := os.Getenv("GOBBONET_" + key); v != "" {
			*dst = v
			return
		}
		if v := os.Getenv("GEMMA_" + key); v != "" {
			warnDeprecated("GEMMA_"+key, "GOBBONET_"+key)
			*dst = v
		}
	}
	envInt := func(key string, dst *int) {
		var raw string
		if v := os.Getenv("GOBBONET_" + key); v != "" {
			raw = v
		} else if v := os.Getenv("GEMMA_" + key); v != "" {
			warnDeprecated("GEMMA_"+key, "GOBBONET_"+key)
			raw = v
		}
		if raw == "" {
			return
		}
		// A malformed number is a mistake worth surfacing, but the environment
		// is not the place to abort startup over — keep the file's value and
		// say why it was not used.
		n, err := strconv.Atoi(raw)
		if err != nil {
			fmt.Fprintf(os.Stderr, " [!] ignoring %s=%q: not a number\n", key, raw)
			return
		}
		*dst = n
	}

	envStr("LLM_URL", &c.LLMURL)
	envStr("SEARCH_URL", &c.SearchURL)
	envStr("EMBED_URL", &c.EmbedURL)
	envStr("LLM_API_KEY", &c.LLMAPIKey)
	envStr("LISTEN_HOST", &c.ListenHost)
	envInt("LISTEN_PORT", &c.ListenPort)
	envStr("SERVER_EXE", &c.ServerExe)
	envStr("MODEL_DIR", &c.ModelDir)
	envStr("WEB_ROOT", &c.WebRoot)
	envStr("DATA_DIR", &c.DataDir)
	envInt("CTX_SIZE", &c.CtxSize)
	envInt("GPU_LAYERS", &c.GPULayers)
	envStr("KV_CACHE_TYPE", &c.KVCacheType)
	envStr("ACCESS_SECRET", &c.AccessSecret)
}

var warnedDeprecated = map[string]bool{}

func warnDeprecated(old, current string) {
	if warnedDeprecated[old] {
		return
	}
	warnedDeprecated[old] = true
	fmt.Fprintf(os.Stderr, " [!] %s is deprecated; use %s\n", old, current)
}

// normalise resolves relative paths, fills in derived defaults, and reads the
// API key file. Relative paths in the config are interpreted against the config
// file's own directory, so a config that lives next to launch.bat behaves the
// way the Windows tree always did.
func (c *Config) normalise() error {
	base := filepath.Dir(c.Path)

	c.LLMURL = normaliseBaseURL(c.LLMURL)
	c.SearchURL = normaliseBaseURL(c.SearchURL)
	c.EmbedURL = normaliseBaseURL(c.EmbedURL)

	if c.DataDir == "" {
		c.DataDir = DataDir()
	}
	c.DataDir = resolveAgainst(base, c.DataDir)

	if c.ModelDir == "" {
		c.ModelDir = filepath.Join(c.DataDir, "models")
	}
	c.ModelDir = resolveAgainst(base, c.ModelDir)

	if c.WebRoot == "" {
		// Auto-detection failing is not a load error. `config get`, `config set`
		// and `check` have no use for the web root, and failing here would stop
		// them working on a machine where the assets live somewhere unusual.
		// The serve path validates it explicitly, where the failure is real and
		// the error message can say what to do about it.
		c.WebRoot = detectWebRoot()
	}
	if c.WebRoot != "" {
		c.WebRoot = resolveAgainst(base, c.WebRoot)
	}

	if c.ServerExe != "" {
		c.ServerExe = resolveAgainst(base, c.ServerExe)
	}
	if c.ChatTemplateFile != "" {
		c.ChatTemplateFile = resolveAgainst(base, c.ChatTemplateFile)
	}

	if c.LLMAPIKeyFile != "" {
		path := resolveAgainst(base, c.LLMAPIKeyFile)
		c.LLMAPIKeyFile = path
		raw, err := os.ReadFile(path)
		if err != nil {
			// The user pointed at a key file; a missing one means requests
			// upstream would go out unauthenticated and fail confusingly later.
			// That is fatal — but only for the commands that actually talk
			// upstream. Reporting it from Load() would break `config get`, which
			// launcher scripts depend on, and would leave the user unable to
			// read or repair any other setting until they hand-edited the file.
			//
			// Same placement as the missing server_exe: recorded here, raised by
			// serve and check, where the failure is real.
			c.Deferred = append(c.Deferred, fmt.Errorf("llm_api_key_file %s: %w", path, err))
		} else {
			c.LLMAPIKey = strings.TrimSpace(string(raw))
		}
	}

	if c.SessionTTLHours <= 0 {
		c.SessionTTLHours = DefaultSessionTTLHours
	}
	if c.JobMaxConcurrent <= 0 {
		c.JobMaxConcurrent = DefaultJobMaxConcurrent
	}
	if c.JobMaxAgeHours <= 0 {
		c.JobMaxAgeHours = DefaultJobMaxAgeHours
	}
	if c.ListenPort <= 0 || c.ListenPort > 65535 {
		return fmt.Errorf("listen_port %d is out of range", c.ListenPort)
	}
	return nil
}

// detectWebRoot finds chat.html relative to the running binary, then the
// current directory, and returns "" if it cannot. A dev run from the repo and an
// installed binary sitting next to a web/ directory both work unconfigured.
func detectWebRoot() string {
	var candidates []string
	if exe, err := os.Executable(); err == nil {
		dir := filepath.Dir(exe)
		candidates = append(candidates, filepath.Join(dir, "web"), dir)
	}
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, filepath.Join(wd, "web"), wd)
	}
	for _, c := range candidates {
		if fileExists(filepath.Join(c, "chat.html")) {
			return c
		}
	}
	return ""
}

func resolveAgainst(base, path string) string {
	if path == "" {
		return path
	}
	if strings.HasPrefix(path, "~") {
		path = filepath.Join(homeDir(), strings.TrimPrefix(path, "~"))
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(base, path)
	}
	return filepath.Clean(path)
}

// normaliseBaseURL accepts "host:port" shorthand and strips trailing slashes so
// callers can concatenate paths without thinking about it.
func normaliseBaseURL(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "http://" + s
	}
	return strings.TrimRight(s, "/")
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------

// Mode reports whether this process supervises llama.cpp.
//
// A non-empty server_exe is a statement of intent. If it points at nothing, that
// is a fatal configuration error, NOT a quiet demotion to remote mode: the old
// behaviour turned one typo into a server that proxied to a port nothing
// listened on while /health-fileserver cheerfully reported "ok".
//
// model_dir deliberately does not enter into it. "Do I supervise the process"
// and "where do I enumerate models" are unrelated questions.
func (c *Config) Mode() (Mode, error) {
	if c.ServerExe == "" {
		return ModeRemote, nil
	}
	st, err := os.Stat(c.ServerExe)
	if err != nil {
		return "", fmt.Errorf("server_exe is set to %q but that file does not exist.\n"+
			"    Fix the path, or set server_exe = \"\" to run in remote mode.", c.ServerExe)
	}
	if st.IsDir() {
		return "", fmt.Errorf("server_exe %q is a directory, not the llama-server binary", c.ServerExe)
	}
	return ModeLocal, nil
}

// serverExeName is the llama.cpp binary's filename on this platform.
func serverExeName() string {
	if runtime.GOOS == "windows" {
		return "llama-server.exe"
	}
	return "llama-server"
}

// HealServerExe repairs a server_exe that names a file which is no longer
// there, when — and only when — there is an unambiguous replacement sitting
// beside this binary.
//
// Mode() is right to treat a missing server_exe as fatal, but it is fatal about
// a value the user never typed. The installer writes an ABSOLUTE path
// ($INSTDIR\llama-cpp\llama-server.exe), so installing to one folder and later
// reinstalling to another leaves the config pointing at the old one. On Linux
// the portable tarball has the same shape: unpack to ~/gobbonet-1.6, let the
// first-run wizard record that path, move the folder, and the config is stale.
// In both cases the correct binary is right next to the gobbonet that is
// running, and refusing to start is a worse answer than using it.
//
// This deliberately does NOT search widely. It looks where our own installers
// put the binary and nowhere else, because silently adopting some other
// llama-server found elsewhere on the machine would be a different program than
// the user installed. If nothing is found, the caller falls through to Mode()'s
// fatal error, which is still the right outcome — there is genuinely nothing to
// run.
//
// Returns the old path when it healed, so the caller can say what it changed.
func (c *Config) HealServerExe() (from string, healed bool) {
	if c.ServerExe == "" {
		return "", false
	}
	if st, err := os.Stat(c.ServerExe); err == nil && !st.IsDir() {
		return "", false
	}

	name := serverExeName()
	var dirs []string
	if exe, err := os.Executable(); err == nil {
		// Resolve symlinks: on Linux the menu entry runs /usr/lib/gobbonet/gobbonet
		// but a packager may well have put a link in /usr/bin.
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		dirs = append(dirs, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		dirs = append(dirs, wd)
	}

	for _, dir := range dirs {
		// llama-cpp/ first: that is where both installers put it. A bare
		// sibling is the portable-unzip layout.
		for _, candidate := range []string{
			filepath.Join(dir, "llama-cpp", name),
			filepath.Join(dir, name),
		} {
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
				old := c.ServerExe
				c.ServerExe = candidate
				return old, true
			}
		}
	}
	return "", false
}

// ---------------------------------------------------------------------------
// The port sidecar
//
// setup-lan.bat reads the web port from .gobbonet-port in the install
// directory; the server reads listen_port from config.toml. Nothing wrote the
// sidecar, and nothing in Go ever read it, so the two could disagree — and when
// they did, the firewall rule and the URL reservation landed on one port while
// the server bound another. The visible symptom is a 503 on the port the user
// was told to visit, from HTTP.SYS answering for a reservation with no listener
// behind it, while the server runs perfectly somewhere else.
//
// The fix is ownership: the process that binds the port is the process that
// writes the file. There is then only one source of truth, and the scripts read
// it rather than guess.
// ---------------------------------------------------------------------------

// PortFilePath is the sidecar's location: beside the running binary, which is
// the "%~dp0.gobbonet-port" that setup-lan.bat and launch.bat already look at.
func PortFilePath() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	return filepath.Join(filepath.Dir(exe), ".gobbonet-port")
}

// WritePortFile records the port actually bound.
//
// Best effort on purpose. On Linux the binary lives in /usr/lib/gobbonet, which
// the user cannot write to, and that is fine: the sidecar exists to feed
// setup-lan.bat, which is Windows-only. A failure here must never stop a server
// that is otherwise ready to serve.
func WritePortFile(port int) error {
	path := PortFilePath()
	if path == "" {
		return errors.New("could not locate the running binary")
	}
	return os.WriteFile(path, []byte(strconv.Itoa(port)+"\n"), 0o644)
}

// ReadPortFile returns the port recorded in the sidecar, or 0.
func ReadPortFile() int {
	path := PortFilePath()
	if path == "" {
		return 0
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return 0
	}
	// Digits only, matching how launch.bat and setup-lan.bat parse it.
	n, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		return 0
	}
	return n
}

// ---------------------------------------------------------------------------
// Derived paths
// ---------------------------------------------------------------------------

func (c *Config) StatePath() string { return filepath.Join(c.DataDir, "state.json") }
func (c *Config) LogFile() string   { return filepath.Join(c.DataDir, "llama-server.log") }

// ModelDirUsable reports whether there is a directory to enumerate GGUFs from.
// Independent of Mode: a remote-mode install may still list local files, and a
// local-mode install may have an empty models directory at first boot.
func (c *Config) ModelDirUsable() bool { return c.ModelDir != "" && isDir(c.ModelDir) }

// HostAllowed implements the Host-header check.
//
// We bind 0.0.0.0 by default, which puts DNS rebinding in scope: an attacker's
// page resolves their domain to 127.0.0.1 and the browser then makes
// same-origin requests to us carrying the session cookie. The defence is to
// refuse Host values we don't recognise.
//
// IP literals are always allowed, because that is exactly how the LAN use case
// works (a phone hits http://192.168.1.50:8080). Rebinding needs a *name*;
// there is nothing to rebind about a literal address the user typed.
func (c *Config) HostAllowed(host string) bool {
	if host == "" {
		// HTTP/1.1 requires Host. Something is malformed; don't guess.
		return false
	}
	name := host
	if h, _, err := splitHostPort(host); err == nil {
		name = h
	}
	name = strings.ToLower(strings.TrimSuffix(name, "."))

	if isIPLiteral(name) {
		return true
	}
	switch name {
	case "localhost", "localhost.localdomain":
		return true
	}
	// mDNS names are how a machine advertises itself on a home LAN, and they
	// resolve only there.
	if strings.HasSuffix(name, ".local") {
		return true
	}
	for _, allowed := range c.AllowedHosts {
		if strings.EqualFold(strings.TrimSpace(allowed), name) {
			return true
		}
	}
	return false
}

func splitHostPort(hostport string) (string, string, error) {
	// net.SplitHostPort rejects a bare host, which is a legal Host header.
	if strings.HasPrefix(hostport, "[") {
		if end := strings.LastIndex(hostport, "]"); end > 0 {
			rest := hostport[end+1:]
			return hostport[1:end], strings.TrimPrefix(rest, ":"), nil
		}
		return "", "", errors.New("malformed bracketed host")
	}
	if i := strings.LastIndex(hostport, ":"); i >= 0 {
		// A bare IPv6 literal has several colons and no port.
		if strings.Count(hostport, ":") == 1 {
			return hostport[:i], hostport[i+1:], nil
		}
	}
	return hostport, "", nil
}

func isIPLiteral(s string) bool {
	return s != "" && net.ParseIP(s) != nil
}
