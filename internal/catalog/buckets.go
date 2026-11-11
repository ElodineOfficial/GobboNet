package catalog

import (
	"fmt"
	"strings"
)

// Buckets are the Add a Model window's types (roadmap 1.7.7): a model is
// tagged with any of them in the catalogue's `tags`, and the window filters on
// them. catalog/gen-catalog.py holds the same list, and
// tests/test-catalog-buckets.py keeps the two equal.
//
// "jack-of-all-trades" is its own tag rather than the existing "general"
// because the live catalogue already puts "general" on nearly every model as a
// description; reusing it would put Mistral 7B -- a roleplay pick -- under
// Jack of all trades too.
var Buckets = []string{"coding", "roleplay", "jack-of-all-trades"}

func isBucket(tag string) bool {
	for _, b := range Buckets {
		if tag == b {
			return true
		}
	}
	return false
}

// BucketTags returns the entry's tags that are buckets, in catalogue order.
func (e Entry) BucketTags() []string {
	var out []string
	for _, t := range e.Tags {
		if isBucket(t) {
			out = append(out, t)
		}
	}
	return out
}

// parseTags reads models.ini's `tags=a,b`: trimmed, lower-cased, de-duplicated.
func parseTags(raw string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range strings.Split(raw, ",") {
		t = strings.ToLower(strings.TrimSpace(t))
		if t == "" || seen[t] {
			continue
		}
		seen[t] = true
		out = append(out, t)
	}
	return out
}

// borrowBuckets gives each entry in c that carries no bucket the buckets of the
// entry in bundled with the same file, and reports how many it filled.
//
// The live catalogue is published separately from this program. Until it
// carries bucket tags of its own, a newer build would otherwise show every
// model under ALL MODELS only, with the bundled copy -- which does carry them
// -- sitting unread beside it. A live entry that has any bucket keeps its own:
// the live list wins wherever it has an opinion.
func borrowBuckets(c, bundled *Catalog) int {
	if c == nil || bundled == nil {
		return 0
	}
	byFile := map[string][]string{}
	for _, e := range bundled.Entries {
		if b := e.BucketTags(); len(b) > 0 {
			byFile[e.File] = b
		}
	}
	filled := 0
	for i := range c.Entries {
		e := &c.Entries[i]
		if len(e.BucketTags()) > 0 {
			continue
		}
		if b, ok := byFile[e.File]; ok {
			tags := append([]string{}, e.Tags...)
			e.Tags = append(tags, b...)
			filled++
		}
	}
	return filled
}

// withBundledBuckets fills a remote or cached catalogue's missing buckets, its
// missing MoE allowances (moe.go) and its missing pins (pins.go) from the
// bundled models.ini, and says so in the notes.
func withBundledBuckets(c *Catalog, bundledPath string, notes []string) []string {
	needs := false
	for _, e := range c.Entries {
		if len(e.BucketTags()) == 0 || (e.MoEMinVRAM == 0 && e.MinRAM == 0) || e.SHA256 == "" {
			needs = true
			break
		}
	}
	if !needs {
		return notes
	}
	if bundledPath == "" {
		bundledPath = Discover()
	}
	if bundledPath == "" {
		return notes
	}
	bundled, err := Load(bundledPath)
	if err != nil {
		return notes
	}
	if n := borrowBuckets(c, bundled); n > 0 {
		notes = append(notes, fmt.Sprintf("took the coding/roleplay/jack-of-all-trades buckets for %d model(s) from the bundled list", n))
	}
	if n := borrowMoE(c, bundled); n > 0 {
		notes = append(notes, fmt.Sprintf("took the MoE small-card allowance for %d model(s) from the bundled list", n))
	}
	if n := borrowPins(c, bundled); n > 0 {
		notes = append(notes, fmt.Sprintf("took the SHA-256 pin for %d model(s) from the bundled list", n))
	}
	return notes
}
