// Package catalog reads installer/models.ini — the model list gen-catalog.py
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
	"os"
	"sort"
	"strconv"
	"strings"
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
		}
		if v, err := strconv.ParseFloat(kv["size_gb"], 64); err == nil {
			e.SizeGB = v
		}
		// A section with no repo or file cannot be downloaded, so it is not a
		// model however well-formed the rest of it looks.
		if e.Repo == "" || e.File == "" {
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
