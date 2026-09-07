package config

// Runtime tuning: the three llama-server launch arguments a user is most
// likely to want to change without editing a file.
//
// These are deliberately a SEPARATE layer from config.toml rather than a
// rewrite of it. config.toml carries what the hardware probe decided —
// installer/gobbonet.nsi writes ctx_size and kv_cache_type there from
// hardware.ini, and on Linux and macOS a human writes them by hand. That is the
// AUTO baseline, and it is the thing "put it back how it was" has to restore.
//
// If /perf wrote into config.toml, the first save would destroy it. Reset could
// then only fall back to the compiled-in 16384/99/q8_0, which is exactly wrong
// on the machines that need reset most: a 6GB card probed down to ctx 8192
// would be "reset" up to 16384 and fail to load. So the override lives beside
// the baseline instead, and reset is a file deletion.
//
// The overlay is applied by the serve path only. `gobbonet config get ctx_size`
// still reports what config.toml says, because that is the file `config set`
// writes — a getter and a setter that disagree about which file they mean would
// be worse than either layer alone.

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
)

// Bounds on what a tuning override may ask for. Wider than any sane value on
// purpose: this rejects nonsense, it does not second-guess someone who knows
// their hardware. Whether the machine can actually load a 200k context is
// answered by llama-server failing to start, which the swap path already
// reports and rolls back.
const (
	MinCtxSize   = 512     // below this nothing useful fits
	MaxCtxSize   = 1048576 // past any current model
	MinGPULayers = 0       // pure CPU: a real choice on a machine whose GPU is busy
	MaxGPULayers = 999     // 99 is llama.cpp's idiom for "all of them"
)

// KVCacheTypes are the quantisations llama-server accepts for --cache-type-k/v.
var KVCacheTypes = []string{"f16", "q8_0", "q4_0"}

// Perf is the tuning overlay. Every field is optional: an override file that
// sets only kv_cache_type leaves the other two on their baseline values.
type Perf struct {
	CtxSize     int    `toml:"ctx_size"`
	GPULayers   int    `toml:"gpu_layers"`
	KVCacheType string `toml:"kv_cache_type"`

	// GPULayersSet distinguishes "override to 0" (pure CPU, a legitimate
	// setting) from "not overridden". The other two have no meaningful zero.
	GPULayersSet bool `toml:"-"`
}

// PerfPath is perf.toml beside the config file it overrides. Same directory on
// purpose: a portable one-folder install keeps both next to the binary, and an
// XDG install keeps both in ~/.config/gobbonet.
func PerfPath(configPath string) string {
	return filepath.Join(filepath.Dir(configPath), "perf.toml")
}

// LoadPerf reads the overlay at path. A missing file is not an error — it is
// the normal state, meaning "no override, use the baseline" — and reports
// exists=false.
//
// A file that exists but is unreadable or out of range IS an error. It was
// written by this server, which validates before writing, so a bad one means
// somebody hand-edited it; saying so and naming the value beats silently
// serving a context size they did not ask for.
func LoadPerf(path string) (p Perf, exists bool, err error) {
	if !fileExists(path) {
		return Perf{}, false, nil
	}

	md, err := toml.DecodeFile(path, &p)
	if err != nil {
		return Perf{}, true, fmt.Errorf("parse %s: %w", path, err)
	}
	if undecoded := md.Undecoded(); len(undecoded) > 0 {
		return Perf{}, true, fmt.Errorf("%s: unknown setting(s): %s; only ctx_size, gpu_layers and kv_cache_type belong here",
			path, joinKeys(undecoded))
	}
	p.GPULayersSet = md.IsDefined("gpu_layers")

	if err := p.Validate(); err != nil {
		return Perf{}, true, fmt.Errorf("%s: %w; fix it or delete the file to go back to automatic settings", path, err)
	}
	return p, true, nil
}

func joinKeys(keys []toml.Key) string {
	out := ""
	for i, k := range keys {
		if i > 0 {
			out += ", "
		}
		out += k.String()
	}
	return out
}

// Validate checks every field that was actually set.
func (p Perf) Validate() error {
	if p.CtxSize != 0 && (p.CtxSize < MinCtxSize || p.CtxSize > MaxCtxSize) {
		return fmt.Errorf("ctx_size %d is outside %d-%d", p.CtxSize, MinCtxSize, MaxCtxSize)
	}
	if p.GPULayersSet && (p.GPULayers < MinGPULayers || p.GPULayers > MaxGPULayers) {
		return fmt.Errorf("gpu_layers %d is outside %d-%d", p.GPULayers, MinGPULayers, MaxGPULayers)
	}
	if p.KVCacheType != "" && !ValidKVCacheType(p.KVCacheType) {
		return fmt.Errorf("kv_cache_type %q is not one of %v", p.KVCacheType, KVCacheTypes)
	}
	return nil
}

// ValidKVCacheType reports whether s is a quantisation llama-server accepts.
func ValidKVCacheType(s string) bool {
	for _, t := range KVCacheTypes {
		if s == t {
			return true
		}
	}
	return false
}

// Apply overlays the set fields onto a baseline tuning triple.
func (p Perf) Apply(ctxSize, gpuLayers int, kvCacheType string) (int, int, string) {
	if p.CtxSize != 0 {
		ctxSize = p.CtxSize
	}
	if p.GPULayersSet {
		gpuLayers = p.GPULayers
	}
	if p.KVCacheType != "" {
		kvCacheType = p.KVCacheType
	}
	return ctxSize, gpuLayers, kvCacheType
}

// ApplyPerf records the config file's tuning as the auto baseline and overlays
// perf.toml on top of it, so CtxSize/GPULayers/KVCacheType become the values
// llama-server should actually be launched with.
//
// Called from the serve path only. Load() deliberately does not do this: it
// backs `config get`, which must keep reporting the file `config set` writes.
func (c *Config) ApplyPerf() error {
	c.AutoCtxSize, c.AutoGPULayers, c.AutoKVCacheType = c.CtxSize, c.GPULayers, c.KVCacheType

	p, exists, err := LoadPerf(PerfPath(c.Path))
	if err != nil {
		return err
	}
	c.PerfOverridden = exists
	c.CtxSize, c.GPULayers, c.KVCacheType = p.Apply(c.CtxSize, c.GPULayers, c.KVCacheType)
	return nil
}

// perfTOML is the written file. It carries its own explanation because the
// place someone finds this file is on disk, not in these sources.
const perfTOML = `# Runtime tuning overrides, written by the settings panel.
#
# These win over ctx_size, gpu_layers and kv_cache_type in config.toml,
# which holds the values your hardware was measured for. Deleting this
# file goes back to those -- that is exactly what the panel's "reset"
# button does.
#
# Editing by hand is fine. Out-of-range values are refused at startup
# rather than ignored, so a typo here stops the server with a message
# instead of quietly running settings you did not choose.
#
#   ctx_size       %d..%d
#   gpu_layers     %d..%d (0 = CPU only, 99 = all layers)
#   kv_cache_type  %v

ctx_size = %d
gpu_layers = %d
kv_cache_type = %q
`

// SavePerf writes the overlay, replacing whatever was there. All three values
// are always written: a partial file is only ever produced by hand, and this
// side of the round trip should leave no ambiguity about what is in force.
func SavePerf(path string, ctxSize, gpuLayers int, kvCacheType string) error {
	p := Perf{CtxSize: ctxSize, GPULayers: gpuLayers, KVCacheType: kvCacheType, GPULayersSet: true}
	if err := p.Validate(); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body := fmt.Sprintf(perfTOML,
		MinCtxSize, MaxCtxSize, MinGPULayers, MaxGPULayers, KVCacheTypes,
		ctxSize, gpuLayers, kvCacheType)
	return os.WriteFile(path, []byte(body), 0o600)
}

// ClearPerf removes the overlay. A file that was already absent is success:
// the caller asked for "no override in force", and that is the result.
func ClearPerf(path string) error {
	err := os.Remove(path)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
