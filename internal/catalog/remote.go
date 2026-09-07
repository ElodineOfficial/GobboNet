package catalog

// Parsing for the remote JSON catalogue served by GoblinCorps.
//
// The wire format is deliberately not the Go structs: it is a published
// contract with its own field names and its own versioning, and pinning the
// two together would mean a rename here silently stops reading the live file.
// wireCatalog mirrors the JSON exactly; ParseRemote converts.
//
// The governing rule for everything below is that a bad catalogue must never
// be worse than no catalogue. Unknown schema version, unparseable JSON, or a
// client too old all mean "use the fallback". A single malformed *entry* means
// "drop that entry and keep the rest" — a partial catalogue still lets someone
// download a model, and refusing the whole list because one row lost its
// filename would be a self-inflicted outage.

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
)

// SchemaVersion is the only remote schema this build understands. A file
// declaring anything else is refused rather than guessed at: the field exists
// precisely so an old client bails cleanly instead of misreading a newer shape.
const SchemaVersion = 1

type wireCatalog struct {
	SchemaVersion int    `json:"schema_version"`
	Generated     string `json:"generated"`
	MinClient     string `json:"min_client"`
	Recommend     struct {
		HeadroomGB int `json:"headroom_gb"`
		Rungs      []struct {
			VRAMGB int `json:"vram_gb"`
			Pick   int `json:"pick"`
		} `json:"rungs"`
		CPUOnly int `json:"cpu_only"`
		Default int `json:"default"`
	} `json:"recommend"`
	Models []wireEntry `json:"models"`
}

// wireEntry uses pointers for the nullable fields. The live catalogue publishes
// `"sha256": null` and `"chat_template": null` today, and null must read as
// "not provided" rather than failing the whole document.
type wireEntry struct {
	Index        int      `json:"index"`
	Display      string   `json:"display"`
	Repo         string   `json:"repo"`
	File         string   `json:"file"`
	SizeGB       float64  `json:"size_gb"`
	MinVRAMGB    int      `json:"min_vram_gb"`
	Ctx          int      `json:"ctx"`
	KV           string   `json:"kv"`
	SHA256       *string  `json:"sha256"`
	ChatTemplate *string  `json:"chat_template"`
	UseJinja     bool     `json:"use_jinja"`
	Tags         []string `json:"tags"`
	Notes        string   `json:"notes"`
}

// ParseRemote validates and converts the remote catalogue.
//
// clientVersion is this build's version, checked against the file's min_client.
// An unparseable client version (a dev build stamped "dev") skips that check
// rather than failing it — see versionAtLeast.
func ParseRemote(body []byte, clientVersion string) (*Catalog, error) {
	var w wireCatalog
	if err := json.Unmarshal(body, &w); err != nil {
		return nil, fmt.Errorf("the catalogue is not valid JSON: %w", err)
	}

	if w.SchemaVersion != SchemaVersion {
		return nil, fmt.Errorf(
			"the catalogue declares schema_version %d and this build understands %d; "+
				"using the bundled list instead", w.SchemaVersion, SchemaVersion)
	}

	if !versionAtLeast(clientVersion, w.MinClient) {
		return nil, fmt.Errorf(
			"the catalogue needs GobboNet %s or newer and this is %s; "+
				"using the bundled list instead", w.MinClient, clientVersion)
	}

	c := &Catalog{
		Source:     "remote",
		Generated:  w.Generated,
		HeadroomGB: w.Recommend.HeadroomGB,
		CPUOnly:    w.Recommend.CPUOnly,
		Default:    w.Recommend.Default,
	}
	for _, r := range w.Recommend.Rungs {
		c.Rungs = append(c.Rungs, Rung{VRAMGB: r.VRAMGB, Pick: r.Pick})
	}

	seen := map[int]bool{}
	for _, m := range w.Models {
		// A row without a repo, a file or a usable index cannot be downloaded,
		// so it is not a model however well-formed the rest of it looks. Same
		// rule Load applies to models.ini.
		if m.Index <= 0 || m.Repo == "" || m.File == "" {
			continue
		}
		// Duplicate indices would make Find ambiguous and the UI's selection
		// meaningless. First wins.
		if seen[m.Index] {
			continue
		}
		seen[m.Index] = true

		e := Entry{
			Index:    m.Index,
			Display:  m.Display,
			Repo:     m.Repo,
			File:     m.File,
			SizeGB:   m.SizeGB,
			MinVRAM:  m.MinVRAMGB,
			Ctx:      m.Ctx,
			KV:       m.KV,
			UseJinja: m.UseJinja,
			Tags:     m.Tags,
			Notes:    m.Notes,
		}
		if m.SHA256 != nil {
			// Normalised and length-checked here so a malformed hash is dropped
			// at the boundary rather than causing a confusing "checksum
			// mismatch" against every download later.
			h := strings.ToLower(strings.TrimSpace(*m.SHA256))
			if isHex64(h) {
				e.SHA256 = h
			}
		}
		if m.ChatTemplate != nil {
			e.ChatTemplate = *m.ChatTemplate
		}
		if e.Display == "" {
			e.Display = e.File
		}
		c.Entries = append(c.Entries, e)
	}

	if len(c.Entries) == 0 {
		return nil, fmt.Errorf("the catalogue contains no usable model entries")
	}

	// Same reasoning as Load: an unhighlighted list reads as "we have no idea",
	// and the smallest model is the safest thing to be wrong about.
	if _, ok := c.Find(c.Default); !ok {
		c.Default = smallest(c.Entries)
	}
	if _, ok := c.Find(c.CPUOnly); !ok {
		c.CPUOnly = smallest(c.Entries)
	}
	return c, nil
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, r := range s {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}

// versionAtLeast reports whether have >= want, comparing dotted numeric
// components.
//
// Two cases deliberately return true rather than false:
//
//   - want is empty. A catalogue that states no minimum imposes none.
//   - have is not a version at all. Development builds are stamped "dev", and
//     a dev build that refuses the live catalogue makes the feature impossible
//     to work on. Failing open here is safe because min_client is a courtesy
//     for old *released* clients, not a security control — nothing about the
//     catalogue is trusted on the strength of it.
//
// Trailing suffixes are ignored: release builds are stamped "1.6-go-abc1234"
// and only the numeric head is meaningful.
func versionAtLeast(have, want string) bool {
	if strings.TrimSpace(want) == "" {
		return true
	}
	h, ok := parseVersion(have)
	if !ok {
		return true
	}
	w, ok := parseVersion(want)
	if !ok {
		return true
	}
	for i := 0; i < len(h) || i < len(w); i++ {
		var hv, wv int
		if i < len(h) {
			hv = h[i]
		}
		if i < len(w) {
			wv = w[i]
		}
		if hv != wv {
			return hv > wv
		}
	}
	return true
}

// parseVersion pulls the leading dotted-numeric run out of a version string.
// "1.6-go-abc1234" is [1 6]; "dev" is not a version and reports false.
func parseVersion(s string) ([]int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, false
	}
	// Cut at the first character that can start a suffix.
	if i := strings.IndexAny(s, "-+ "); i >= 0 {
		s = s[:i]
	}
	parts := strings.Split(s, ".")
	out := make([]int, 0, len(parts))
	for _, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil {
			// A leading non-numeric component means this is not a version.
			if len(out) == 0 {
				return nil, false
			}
			break
		}
		out = append(out, n)
	}
	if len(out) == 0 {
		return nil, false
	}
	return out, true
}
