// Package catalog reads catalog/models.ini — the model list gen-catalog.py
// generates from launch.bat.
//
// The file is shipped beside the binary rather than compiled in, so the
// catalogue can be corrected without a rebuild, and so the Linux package and
// the Windows installer read the same bytes. gen-catalog.py writes CRLF and a
// [section]-per-model layout because NSIS's ReadINIStr wraps Win32
// GetPrivateProfileString; both are accommodated here rather than reformatted,
// since launch.bat remains the source of truth for all of it.
package catalog

import (
	"bufio"
	"fmt"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/models"
)

// Entry is one model in the catalogue.
//
// The first eight fields are what models.ini has always carried. The rest
// arrive only from the remote JSON catalogue and are zero when the entry came
// from the .ini — nothing may assume they are populated.
type Entry struct {
	Index   int     // the [N] section number, and what the UI submits
	Display string  // human name, e.g. "Llama 3.2 3B Instruct"
	Repo    string  // HuggingFace repo, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF"
	File    string  // GGUF filename within the repo
	SizeGB  float64 // download size, for the disk-space check and the UI
	MinVRAM int     // VRAM rung this model was placed on
	Ctx     int     // context size to configure when this model is picked
	KV      string  // kv_cache_type to configure alongside Ctx

	// MoEMinVRAM and MinRAM are the Mixture-of-Experts allowance (issue #65):
	// the model also fits a card of MoEMinVRAM GB when the machine has MinRAM
	// GB of system RAM, because automatic placement keeps most experts in RAM.
	// Zero for dense models, and for catalogues that predate the fields.
	MoEMinVRAM int
	MinRAM     int

	// SHA256 is the expected hash, recorded in the catalogue at generation
	// time. Its value is that it does NOT come from the download host: the
	// weights and their LFS pointer both come from HuggingFace, so verifying
	// one against the other proves transfer integrity but not authenticity.
	// A hash from a second host means two parties would have to agree in order
	// to lie.
	//
	// Empty is normal and not an error — models.ini has no such field, and the
	// live catalogue currently publishes null for every entry. Callers fall
	// back to the LFS pointer, which is what shipped before this existed.
	SHA256 string

	// ChatTemplate and UseJinja carry per-model launch configuration that had
	// nowhere to live before. Some models need a specific template, or need
	// llama-server's Jinja path with a blank template.
	ChatTemplate string
	UseJinja     bool

	// Tags and Notes are for the picker: a short classification ("reasoning",
	// "moe", "cpu-friendly") and free text from the catalogue author.
	Tags  []string
	Notes string

	// TierHint is the catalogue's own say on the tier (1.7.9): "small", "mid",
	// "large" or "moe". Optional; Tier() works one out when it is empty or
	// not one of those. Lets the published list place a model by hand.
	TierHint string
}

// Tiers are the Add a Model window's groups (1.7.9, F2), in the order shown.
var Tiers = []string{"small", "mid", "large", "moe"}

// Tier is the group the model is listed under. The catalogue's hint wins;
// otherwise a model with an MoE allowance is "moe" (its size is not the
// whole story), and the rest go by the card they need, on the same lines as
// the window's Light / Medium / Heavy filter: 8 GB or less, up to 16, more.
func (e Entry) Tier() string {
	for _, t := range Tiers {
		if e.TierHint == t {
			return t
		}
	}
	if e.MoEMinVRAM > 0 && e.MinRAM > 0 {
		return "moe"
	}
	switch {
	case e.MinVRAM <= 8:
		return "small"
	case e.MinVRAM <= 16:
		return "mid"
	}
	return "large"
}

// Verified reports whether the catalogue pins this file's SHA-256 itself.
// Unpinned entries still download -- checked against HuggingFace's own
// record -- but the window marks them UNVERIFIED and the server wants a
// second, explicit yes before starting one (internal/server, models.go).
func (e Entry) Verified() bool { return e.SHA256 != "" }

// Fits reports whether the model suits a machine with vramGB of GPU memory and
// ramGB of system RAM: the whole model's MinVRAM, or -- for a Mixture-of-
// Experts model -- its smaller MoEMinVRAM card with MinRAM of RAM beside it.
// An unknown figure is 0 and confirms nothing.
func (e Entry) Fits(vramGB, ramGB int) bool {
	if vramGB > 0 && vramGB >= e.MinVRAM {
		return true
	}
	return e.MoEMinVRAM > 0 && e.MinRAM > 0 &&
		vramGB >= e.MoEMinVRAM && ramGB >= e.MinRAM
}

// DownloadURL is where the weights live.
func (e Entry) DownloadURL() string {
	return "https://huggingface.co/" + e.Repo + "/resolve/main/" + e.File
}

// PointerURL is the same object served as text. HuggingFace stores GGUFs in
// LFS, so /raw/ returns the pointer — three lines including "oid sha256:<hex>"
// — which is where the expected checksum comes from. launch.bat and the NSIS
// wizard both verify against this and nothing else; there is no hash in the
// catalogue to compare with.
func (e Entry) PointerURL() string {
	return "https://huggingface.co/" + e.Repo + "/raw/main/" + e.File
}

// Catalog is the parsed file.
type Catalog struct {
	Entries []Entry
	// CPUOnly is the entry to offer when there is no usable GPU. Part 8 of the
	// build spec flags this as the rung Linux will hit most often, integrated
	// graphics being a larger share of Linux desktops than Windows ones.
	CPUOnly int
	// Default is the fallback when nothing else matches.
	Default int

	// HeadroomGB and Rungs come from the remote catalogue's `recommend` block.
	// They are parsed and carried so the hardware recommendation can move here
	// later; nothing consumes them yet. Zero when the catalogue came from
	// models.ini.
	HeadroomGB int
	Rungs      []Rung

	// Source names where this came from — "remote", "cache", or "bundled" —
	// so the UI can say so and a bug report can tell which list was in play.
	Source string
	// Generated is the catalogue's own timestamp, empty for models.ini.
	Generated string
}

// Rung is one step of the VRAM ladder: a card clearing vram_gb is offered the
// model at Pick.
type Rung struct {
	VRAMGB int
	Pick   int
}

// Find returns the entry with the given index.
func (c *Catalog) Find(index int) (Entry, bool) {
	for _, e := range c.Entries {
		if e.Index == index {
			return e, true
		}
	}
	return Entry{}, false
}

// Load parses models.ini.
func Load(path string) (*Catalog, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("could not read the model catalogue at %s: %w", path, err)
	}
	defer f.Close()

	sections := map[string]map[string]string{}
	current := ""

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		// gen-catalog.py writes CRLF for the Win32 INI reader.
		line := strings.TrimSpace(strings.TrimSuffix(sc.Text(), "\r"))
		if line == "" || strings.HasPrefix(line, ";") || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			current = strings.TrimSuffix(strings.TrimPrefix(line, "["), "]")
			if _, ok := sections[current]; !ok {
				sections[current] = map[string]string{}
			}
			continue
		}
		if current == "" {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		sections[current][strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	if err := sc.Err(); err != nil {
		return nil, fmt.Errorf("could not read %s: %w", path, err)
	}

	c := &Catalog{}
	for name, kv := range sections {
		index, err := strconv.Atoi(name)
		if err != nil {
			continue // [catalog] and [recommend], handled below
		}
		e := Entry{
			Index:   index,
			Display: kv["display"],
			Repo:    kv["repo"],
			File:    kv["file"],
			MinVRAM: atoiOr(kv["min_vram"], 0),
			Ctx:     atoiOr(kv["ctx"], 0),
			KV:      kv["kv"],
			Tags:    parseTags(kv["tags"]),

			MoEMinVRAM: atoiOr(kv["moe_min_vram"], 0),
			MinRAM:     atoiOr(kv["min_ram"], 0),
			TierHint:   strings.ToLower(strings.TrimSpace(kv["tier"])),
		}
		if v, err := strconv.ParseFloat(kv["size_gb"], 64); err == nil {
			e.SizeGB = v
		}
		// sha256 is optional and local. models.ini is the catalogue an operator
		// controls — bundled by the installer, or hand-edited for a private or
		// air-gapped set of models — so a hash written here is a genuinely
		// independent pin rather than a number fetched from the same host that
		// serves the weights.
		//
		// Validated at the boundary for the same reason remote.go validates the
		// JSON field: a typo must be dropped here, where it can be reported as
		// a bad catalogue, rather than surface later as a checksum mismatch on
		// a download that was fine.
		//
		// A rejected pin is logged rather than dropped quietly. Silently
		// ignoring a malformed security control leaves an operator believing a
		// download is pinned when it is not, which is worse than not offering
		// the field at all.
		if h := strings.ToLower(strings.TrimSpace(kv["sha256"])); h != "" {
			if isHex64(h) {
				e.SHA256 = h
			} else {
				log.Printf("[catalog] ignoring sha256 for %s: not 64 hex characters", kv["file"])
			}
		}
		// A section with no repo or file cannot be downloaded, so it is not a
		// model however well-formed the rest of it looks.
		if e.Repo == "" || e.File == "" {
			continue
		}
		// The file name becomes the download's name in the models folder, so
		// it must be a plain .gguf name (1.8.0): a "../x" here would write
		// outside it.
		if err := models.CheckFileName(e.File); err != nil {
			log.Printf("[catalog] skipping %q: %v", e.File, err)
			continue
		}
		if e.Display == "" {
			e.Display = e.File
		}
		c.Entries = append(c.Entries, e)
	}

	if len(c.Entries) == 0 {
		return nil, fmt.Errorf("%s contains no usable model entries", path)
	}
	sort.Slice(c.Entries, func(i, j int) bool { return c.Entries[i].Index < c.Entries[j].Index })
	c.Source = "bundled"

	rec := sections["recommend"]
	c.CPUOnly = atoiOr(rec["cpu_only"], 0)
	c.Default = atoiOr(rec["default"], 0)
	// Fall back to the smallest entry rather than leaving the UI with no
	// preselection: an unhighlighted list reads as "we have no idea", and the
	// smallest model is the safest thing to be wrong about.
	if _, ok := c.Find(c.Default); !ok {
		c.Default = smallest(c.Entries)
	}
	if _, ok := c.Find(c.CPUOnly); !ok {
		c.CPUOnly = smallest(c.Entries)
	}
	return c, nil
}

func smallest(entries []Entry) int {
	best := entries[0]
	for _, e := range entries[1:] {
		if e.SizeGB < best.SizeGB {
			best = e
		}
	}
	return best.Index
}

func atoiOr(s string, fallback int) int {
	if v, err := strconv.Atoi(s); err == nil {
		return v
	}
	return fallback
}
