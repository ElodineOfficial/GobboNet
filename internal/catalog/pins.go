package catalog

// borrowPins gives each entry in c that carries no SHA-256 the pin of the entry
// in bundled with the same repo and file, and reports how many it filled
// (1.8.0).
//
// Same reasoning as borrowBuckets and borrowMoE, with one difference that
// matters here: the match is on repo AND file, because a pin names exactly one
// file, and a same-named file in another repo is a different file. The live
// list is published separately from this program. A release that ships its
// catalogue pinned would otherwise show those models UNVERIFIED -- and download
// them without a pin to check -- for as long as the live list is older than
// the release, which is precisely what happened while 1.8.0's pins waited for
// their upload.
//
// A live pin is never replaced. When the two disagree the live list is the
// newer record (a model re-uploaded on HuggingFace and re-pinned), and either
// way the download is still checked against a pin, never against nothing.
func borrowPins(c, bundled *Catalog) int {
	if c == nil || bundled == nil {
		return 0
	}
	byFile := map[string]string{}
	for _, e := range bundled.Entries {
		if e.SHA256 != "" && e.Repo != "" && e.File != "" {
			byFile[e.Repo+"\x00"+e.File] = e.SHA256
		}
	}
	filled := 0
	for i := range c.Entries {
		e := &c.Entries[i]
		if e.SHA256 != "" {
			continue
		}
		if pin, ok := byFile[e.Repo+"\x00"+e.File]; ok {
			e.SHA256 = pin
			filled++
		}
	}
	return filled
}
