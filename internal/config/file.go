package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
)

// DefaultTOML is written verbatim when no config file exists. The comments are
// the documentation: a user who opens this file should be able to understand and
// change every setting without reading anything else.
const DefaultTOML = `# ================================================================
# GOBBONET - LOCAL AI CHAT
# ================================================================
#
# This is the shared configuration file. It is written by the
# setup scripts (launch.bat on Windows, launch.sh on Linux) but
# can also be edited manually. After editing, restart the
# server to pick up changes.
#
# You can also read and write single values without a TOML
# parser, which is how the launcher scripts use it:
#   gobbonet config get llm_url
#   gobbonet config set llm_url http://192.168.1.100:8080
# ================================================================

# --- Upstream llama.cpp server ------------------------------------------
# Base URL of the llama-server process. This can be:
#   http://127.0.0.1:11437      - local llama.cpp server
#   http://192.168.1.100:8080   - remote machine on your LAN
#                                 (8080 is llama.cpp's own default)
#   https://your-server.com     - remote with TLS
#
# The UI and chat state are served by this program. The llama.cpp
# server handles model inference. They talk over HTTP.
#
# 11437 and not 11434 because 11434 is Ollama's port. Sharing it meant
# the launcher saw Ollama answering, assumed llama-server was already
# up, and never started its own.
llm_url = "http://127.0.0.1:11437"

# --- Optional upstream services -----------------------------------------
# If nothing answers, features degrade gracefully: web search turns off
# and RAG falls back to tag-only retrieval. Leave empty to disable.
#
# search_url is the web-search API this server forwards /search to. It is
# the ONLY upstream that is not on your machine, and it is reached only
# when you turn search on and supply your own key -- which the browser
# sends and this server passes through without storing. Point it at your
# own relay if you would rather it not talk to ollama.com directly, or
# empty it to switch the feature off.
search_url = "https://ollama.com/api"
embed_url = "http://127.0.0.1:11436"

# --- Model catalogue ----------------------------------------------------
# The list of downloadable models shown by "Add a Model" in the config
# panel. Keeping it online means models added after your install show up
# without you reinstalling anything.
#
# This is the second and last thing GobboNet fetches from the internet,
# after web search. What it sends: a plain GET for a static ~5 KB JSON
# file. No query parameters, no cookies, no identifier, no telemetry, and
# in particular NOT your hardware -- the whole list is downloaded and
# filtered on your machine rather than asking a server what fits your GPU.
# The browser is never involved; this binary does the fetching.
#
# The answer is cached for a day, so this is at most one request per day
# and usually fewer. Set model_catalog_remote = false to switch it off
# entirely: nothing is requested, and the list comes from the cache or
# the models.ini that shipped with GobboNet. Downloading a model still
# works either way.
model_catalog_remote = true
model_catalog_url = "https://goblincorps.com/gobbonet_model_list.json"

# API key sent to the upstream llama.cpp server (never exposed to the
# browser). Set this if your upstream requires authentication.
# Alternatives, either of which wins over the value below:
#   llm_api_key_file = "/path/to/key"   # read from a file at startup
#   GOBBONET_LLM_API_KEY=...            # or from the environment
llm_api_key = ""

# --- Listener -----------------------------------------------------------
# 0.0.0.0   = accept connections on all interfaces (phones on the LAN).
# 127.0.0.1 = loopback only (no LAN access).
#
# 9066 is "gobb" on a phone keypad. It is not 8080 because 8080 is the
# port every other dev tool also wants, and on Windows the ranges
# Hyper-V, WSL2 and Docker reserve can swallow it -- which shows up as a
# bind failure that netstat cannot explain. If you change this, stay
# under 32768: above that you are in the range Windows hands out to
# outbound connections, and the two can race for the same number.
listen_host = "0.0.0.0"
listen_port = 9066

# Extra hostnames allowed in the Host header. IP addresses, "localhost"
# and any *.local name are always accepted, which covers normal LAN use.
# Add a name here only if you reach this server through DNS.
# allowed_hosts = ["gobbonet.example.com"]

# --- Local-backend (hot-swap) settings ----------------------------------
# Set server_exe to the llama-server binary to run in LOCAL MODE, where
# this program starts, supervises and hot-swaps llama.cpp for you.
#
# Leave it empty for REMOTE MODE, where llm_url points at a server that
# something else manages. Both modes have full feature parity except
# hot-swap: auth, state sync, generation jobs, web search, RAG, and
# everything else behave identically.
#
# A non-empty server_exe that points at a missing file is a fatal error,
# not a silent fall back to remote mode.
server_exe = ""

# Maximum layers to offload to GPU (0 = CPU only, 99 = all layers).
gpu_layers = 99

# Context window in tokens. Must not exceed the model's maximum.
ctx_size = 16384

# KV cache quantization type. Common values: q8_0, q4_0, f16.
kv_cache_type = "q8_0"

# --- Directories --------------------------------------------------------
# Server-side data: models, the chat state backup, and llama-server logs.
# Defaults to ~/.local/share/gobbonet -- the XDG data directory. Config is
# not data, so nothing large is ever written next to this file.
# data_dir = ""

# Directory containing .gguf model files. These appear in the model
# selector dropdown. Scanned on demand, so dropping a new GGUF in here
# makes it show up without a restart.
#
# Defaults to <data_dir>/models. Set a RELATIVE path to pin it next to this
# config file instead, which is what a portable one-folder install wants:
#   model_dir = "./models"
# model_dir = ""

# Where chat.html and friends live. Leave empty to auto-detect next to
# the binary.
# web_root = ""

# --- Access control -----------------------------------------------------
# Set by "gobbonet set-password". Stored as an Argon2id hash; a legacy
# salt:hash SHA-256 secret from the Windows install is still accepted and
# is upgraded to Argon2id automatically on the next successful login.
# If empty, the server prompts on first run.
access_secret = ""

# --- Chat template overrides (optional) ---------------------------------
# Only needed if a model's embedded template is broken. Normally the
# server works this out from the GGUF header.
# chat_template_name = "mistral-v7"
# chat_template_file = ""

# --- Session & job settings ---------------------------------------------
# Session cookie lifetime in hours. Short on purpose: the cookie crosses
# the LAN in plain text, so a shorter window means a sniffed cookie stops
# working sooner.
session_ttl_hours = 12

# Maximum concurrent detached-generation workers. Generations are held in
# memory, not spooled to disk.
#
# One, because llama-server serves one at a time. Sending a new
# generation while one is running SUPERSEDES it -- the old one is
# cancelled and waited out before the new one is dispatched -- rather
# than queueing behind it or being refused. Raise this only if your
# upstream really does run multiple slots.
job_max_concurrent = 1

# How long a finished generation stays available for a client to collect.
job_max_age_hours = 48
`

// WriteDefault creates path (and its directory) with the commented default
// config, at 0600 because access_secret and llm_api_key end up in here.
func WriteDefault(path string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(DefaultTOML), 0o600)
}

// ---------------------------------------------------------------------------
// config get / config set
//
// The launcher scripts must not have to parse TOML. They shell out to the
// binary they already carry, which keeps Go the only TOML parser in the tree.
// ---------------------------------------------------------------------------

// fieldByTOMLKey finds the struct field carrying a given toml tag.
func fieldByTOMLKey(c *Config, key string) (reflect.Value, bool) {
	v := reflect.ValueOf(c).Elem()
	t := v.Type()
	for i := 0; i < t.NumField(); i++ {
		tag := t.Field(i).Tag.Get("toml")
		if tag == key {
			return v.Field(i), true
		}
	}
	return reflect.Value{}, false
}

// Keys lists every settable config key, in declaration order.
func Keys() []string {
	var out []string
	t := reflect.TypeOf(Config{})
	for i := 0; i < t.NumField(); i++ {
		if tag := t.Field(i).Tag.Get("toml"); tag != "" && tag != "-" {
			out = append(out, tag)
		}
	}
	return out
}

// Get returns one value as a plain string, suitable for shell capture.
// Lists come back space-separated so `for h in $(gobbonet config get ...)` works.
func (c *Config) Get(key string) (string, error) {
	field, ok := fieldByTOMLKey(c, key)
	if !ok {
		return "", fmt.Errorf("unknown config key %q", key)
	}
	switch field.Kind() {
	case reflect.String:
		return field.String(), nil
	case reflect.Int:
		return strconv.FormatInt(field.Int(), 10), nil
	case reflect.Bool:
		return strconv.FormatBool(field.Bool()), nil
	case reflect.Slice:
		var parts []string
		for i := 0; i < field.Len(); i++ {
			parts = append(parts, field.Index(i).String())
		}
		return strings.Join(parts, " "), nil
	default:
		return "", fmt.Errorf("config key %q has an unsupported type", key)
	}
}

// Set rewrites one key in the file at path, in place.
//
// This edits lines rather than re-serialising the parsed document, because
// re-serialising would discard every comment in the file — and the comments are
// the documentation. If the key is absent it is appended.
func Set(path, key, value string) error {
	if _, ok := fieldByTOMLKey(&Config{}, key); !ok {
		return fmt.Errorf("unknown config key %q", key)
	}
	// Validate the value against the field's type before touching the file, so
	// a bad `config set` can't leave an unparseable config behind.
	if err := validateValue(key, value); err != nil {
		return err
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}

	line := key + " = " + formatValue(key, value)
	// Matches an active assignment, or a commented-out default written in the
	// canonical form this file uses: comment marker at column 0, one optional
	// space, then the key. Uncommenting a documented default is therefore just
	// `config set`.
	//
	// The anchoring is deliberate. DefaultTOML also contains *indented* examples
	// inside prose blocks ("#   model_dir = \"./models\""), and those are
	// documentation, not settings. A looser `^\s*#?\s*` pattern matches them
	// first — every key is replaced at its first hit — which silently eats the
	// explanation and leaves the real commented default untouched below it.
	pattern := regexp.MustCompile(`^#? ?` + regexp.QuoteMeta(key) + `\s*=`)

	var out []string
	replaced := false
	scanner := bufio.NewScanner(strings.NewReader(string(raw)))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if !replaced && pattern.MatchString(text) {
			out = append(out, line)
			replaced = true
			continue
		}
		out = append(out, text)
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	if !replaced {
		out = append(out, line)
	}

	body := strings.Join(out, "\n")
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	// Write-then-rename so an interrupted write can't truncate the config.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(body), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func validateValue(key, value string) error {
	field, _ := fieldByTOMLKey(&Config{}, key)
	switch field.Kind() {
	case reflect.Int:
		if _, err := strconv.Atoi(value); err != nil {
			return fmt.Errorf("%s must be a number, got %q", key, value)
		}
	case reflect.Bool:
		if _, err := strconv.ParseBool(value); err != nil {
			return fmt.Errorf("%s must be true or false, got %q", key, value)
		}
	}
	return nil
}

func formatValue(key, value string) string {
	field, _ := fieldByTOMLKey(&Config{}, key)
	switch field.Kind() {
	case reflect.Int, reflect.Bool:
		return value
	case reflect.Slice:
		parts := strings.Fields(value)
		quoted := make([]string, len(parts))
		for i, p := range parts {
			quoted[i] = strconv.Quote(p)
		}
		return "[" + strings.Join(quoted, ", ") + "]"
	default:
		return strconv.Quote(value)
	}
}
