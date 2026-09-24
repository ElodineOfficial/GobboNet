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

	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
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
#
# Everything above the [ui] section at the bottom is for the
# SERVER. The [ui] section presets things in the chat page
# instead -- see the note down there.
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

# Refuse to download a model that carries no published checksum.
#
# A download is verified against the catalogue's sha256 where there is
# one, and against the hash HuggingFace records for the file otherwise.
# The first is the stronger check: it does not come from the host serving
# the weights, so the two would have to agree in order to lie. When both
# exist and disagree, the download is refused outright.
#
# Left false because the models.ini that ships here carries no hashes and
# the published catalogue does not yet either, so turning it on refuses
# every stock download. Turn it on when you run a catalogue of your own
# with a sha256 on every entry -- then a missing hash means the catalogue
# is wrong, and you want to hear about it rather than download anyway.
require_checksum = false

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

# GPU placement: -1 = automatic fitting with headroom, 0 = CPU only.
# A positive number is an explicit layer count (99 requests up to 99).
# Auto preserves your model, context and KV precision; CPU work may be slower.
# Requires an engine supporting --fit and --fit-target (pinned b10456 does).
gpu_layers = -1

# Free GPU memory targeted by automatic fitting, per device, in MiB.
# A target, not a hard allocation cap; other applications can allocate later.
# CPU offload uses system RAM. No model or context reduction is performed.
gpu_reserve_mib = 1024

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

# idle_standdown_minutes
#   Unload the model after this many minutes with no messages,
#   freeing its VRAM, and reload it on the next one. 0 keeps it
#   loaded always. Default 5.
#
#   Only does anything when THIS server runs llama.cpp. In remote
#   mode the process belongs to someone else and stopping it is
#   not ours to do.
#
#   The reload costs the same as a cold start, so a short timeout
#   trades waiting for memory. Also in CONFIG in the chat page.

# show_engine_output
#   Mirror llama.cpp's own output into this window as the model
#   loads, so you can watch it happen and see whether your GPU
#   is being used. Default true.
#
#   Turn it off for a machine where nobody reads the console.
#   The log file is written either way; "gobbonet doctor" says
#   where it is.

# ================================================================
# [ui] -- presets for the chat page
# ================================================================
#
# Everything above is the server. This section is the browser: it
# seeds the settings you would otherwise set by hand in CONFIG, on
# every device that opens this server.
#
# It is a SEED, not a lock. A device with no settings of its own
# takes these on its first visit. A device that already has
# settings keeps them, and is offered these under DATA -> SERVER
# PRESETS, where you can see exactly what differs and apply it in
# one click. Nothing here ever overwrites a choice someone made on
# their own device without being asked.
#
# Keys are the same ones the chat page uses. The full list, with
# the value each one has right now, is shown under
# DATA -> SERVER PRESETS -- read it there rather than from this
# comment, because that list is generated from the page itself and
# cannot go stale.
#
# Unknown keys and wrong types are ignored and reported there too,
# so a typo is visible rather than silent.
#
# [ui]
# stream_replies = true      # or streamReplies -- either spelling works
# auto_scroll = "smart"      # "smart" | "always" | "off"
# sticky_cards = true
# token_limit = 24576

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
//
// Table-valued fields such as [ui] are skipped. `config get`/`config set` deal
// in single scalar values for the launcher scripts, and there is no sensible
// string form of a whole table -- so listing it as a key would only advertise
// a command that cannot work. Detected by kind rather than by name, so a table
// added later is excluded without anyone having to remember.
func Keys() []string {
	var out []string
	t := reflect.TypeOf(Config{})
	for i := 0; i < t.NumField(); i++ {
		if t.Field(i).Type.Kind() == reflect.Map {
			continue
		}
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

	// Every key this function can set is a ROOT-level key, so both the search
	// and the insert have to stay above the first table header.
	//
	// This used to append at EOF and match anywhere, which was correct for as
	// long as the file had no tables in it. The [ui] section changed that, and
	// the failure is silent in the worst way: `config set listen_port 9999`
	// appended the line after [ui], TOML read it back as ui.listen_port, the
	// real listen_port kept its old value, and the command reported success.
	// The launcher scripts drive this, so a silently ineffective write is a
	// machine that comes up on the wrong port with nothing in any log.
	tableHeader := regexp.MustCompile(`^\s*\[`)

	var out []string
	replaced := false
	inRoot := true
	firstTableAt := -1
	scanner := bufio.NewScanner(strings.NewReader(string(raw)))
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for scanner.Scan() {
		text := scanner.Text()
		if inRoot && tableHeader.MatchString(text) {
			inRoot = false
			firstTableAt = len(out)
		}
		if inRoot && !replaced && pattern.MatchString(text) {
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
		if firstTableAt < 0 {
			out = append(out, line)
		} else {
			// Insert above the comment block that introduces the table rather
			// than immediately above the header, so the explanation stays
			// attached to the section it explains.
			at := firstTableAt
			for at > 0 {
				prev := strings.TrimSpace(out[at-1])
				if prev == "" || strings.HasPrefix(prev, "#") {
					at--
					continue
				}
				break
			}
			out = append(out, "")
			copy(out[at+1:], out[at:])
			out[at] = line
		}
	}

	body := strings.Join(out, "\n")
	if !strings.HasSuffix(body, "\n") {
		body += "\n"
	}
	// Write-then-rename so an interrupted write can't truncate the config, via
	// atomicfile so two concurrent Set calls get their own temp files. They used
	// to share path+".tmp": the first rename moved it away and the second failed
	// with ENOENT, which is how a double-click on the setup wizard's last button
	// produced a 500 on a write that had nothing wrong with it.
	return atomicfile.Write(path, []byte(body), 0o600)
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
