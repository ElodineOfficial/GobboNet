package mods

// Endorsed mods (1.7.9, F6): a list Elodine publishes at goblincorps.com,
// where she endorses each mod individually, browsed from the MODS panel and
// installed with one click.
//
// # The list
//
//	{
//	  "schema_version": 1,
//	  "generated": "2026-10-27T18:00:00Z",
//	  "min_client": "1.7.0",
//	  "mods": [{
//	    "id": "neon-theme", "name": "Neon theme", "author": "Elodine",
//	    "version": "1.2.0", "description": "Pinker everything.",
//	    "homepage": "https://goblincorps.com/gobbonet_extras",
//	    "adult": false, "min_client": "1.7.9",
//	    "files": [{"path": "neon.css", "url": "https://...", "sha256": "<64 hex>", "size": 1234}]
//	  }]
//	}
//
// Every file carries its own SHA-256, and the install refuses, with one clear
// line, if any file does not match; nothing is half-installed. A file is
// fetched from its url and saved under its path, so a mod the site hands out
// as a .txt can land as a .js. "type" other than "mod" (characters, prompts)
// is skipped for now.
//
// # Privacy
//
// The list is fetched only when the browse panel is opened, a plain GET with
// nothing identifying, by this binary rather than the browser. Files are
// fetched only on INSTALL. mod_list_url points it anywhere, or blank turns
// it off.
//
// # The switch belongs to the user
//
// A newly installed endorsed mod is switched on once, at install. After that
// its switch is the user's: an update replaces the files and keeps the switch
// exactly as it was.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
	"github.com/ElodineOfficial/GobboNet/internal/catalog"
)

const (
	// DefaultListURL is where the endorsed list is published.
	DefaultListURL = "https://goblincorps.com/gobbonet_mod_list.json"
	// ListSchema is the list format this build reads.
	ListSchema = 1

	listCacheName  = "mod-list-cache.json"
	listTimeout    = 5 * time.Second
	maxListBytes   = 1 << 20
	fileTimeout    = 30 * time.Second
	maxModFiles    = 20
	maxModFileSize = 5 << 20
	maxModBytes    = 20 << 20
)

// ListFile is one file of an endorsed mod.
type ListFile struct {
	Path   string `json:"path"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size,omitempty"`
}

// ListEntry is one endorsed mod.
type ListEntry struct {
	ID          string     `json:"id"`
	Type        string     `json:"type,omitempty"`
	Name        string     `json:"name"`
	Author      string     `json:"author,omitempty"`
	Version     string     `json:"version"`
	Description string     `json:"description,omitempty"`
	Homepage    string     `json:"homepage,omitempty"`
	Adult       bool       `json:"adult,omitempty"`
	MinClient   string     `json:"min_client,omitempty"`
	Files       []ListFile `json:"files"`
	// Problem is set by ParseList when this build cannot install the entry
	// (it needs a newer GobboNet). Listed anyway, so the user is told.
	Problem string `json:"problem,omitempty"`
}

// List is the published list, after checking.
type List struct {
	SchemaVersion int         `json:"schema_version"`
	Generated     string      `json:"generated,omitempty"`
	MinClient     string      `json:"min_client,omitempty"`
	Mods          []ListEntry `json:"mods"`
	// Source is "remote" or "cache"; URL is where it came from.
	Source string `json:"-"`
	URL    string `json:"-"`
}

// Find returns the entry with this id.
func (l *List) Find(id string) (ListEntry, bool) {
	if l == nil {
		return ListEntry{}, false
	}
	for _, e := range l.Mods {
		if e.ID == id {
			return e, true
		}
	}
	return ListEntry{}, false
}

var allowedExt = map[string]bool{
	".css": true, ".js": true, ".mjs": true, ".json": true, ".txt": true, ".md": true,
	".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".webp": true, ".svg": true,
	".woff": true, ".woff2": true, ".ttf": true,
}

// ParseList reads and checks a list. Entries that are malformed are left out,
// each with a note saying why; the list as a whole fails only when it cannot
// be read at all or is for a newer GobboNet.
func ParseList(body []byte, clientVersion string) (*List, []string, error) {
	var l List
	if err := json.Unmarshal(body, &l); err != nil {
		return nil, nil, fmt.Errorf("the endorsed list is not valid JSON: %w", err)
	}
	if l.SchemaVersion != ListSchema {
		return nil, nil, fmt.Errorf("the endorsed list is schema_version %d and this build reads %d", l.SchemaVersion, ListSchema)
	}
	if !catalog.VersionAtLeast(clientVersion, l.MinClient) {
		return nil, nil, fmt.Errorf("the endorsed list needs GobboNet %s or newer and this is %s", l.MinClient, clientVersion)
	}
	var notes []string
	var keep []ListEntry
	seen := map[string]bool{}
	skippedOther := 0
	for _, e := range l.Mods {
		if e.Type != "" && e.Type != "mod" {
			skippedOther++
			continue
		}
		if why := checkEntry(&e); why != "" {
			notes = append(notes, fmt.Sprintf("left out %q: %s", e.ID, why))
			continue
		}
		if seen[e.ID] {
			notes = append(notes, fmt.Sprintf("left out a second %q", e.ID))
			continue
		}
		seen[e.ID] = true
		if e.MinClient != "" && !catalog.VersionAtLeast(clientVersion, e.MinClient) {
			e.Problem = "needs GobboNet " + e.MinClient + " or newer"
		}
		keep = append(keep, e)
	}
	if skippedOther > 0 {
		notes = append(notes, fmt.Sprintf("%d entries that are not mods (characters, prompts) are not installed from here yet", skippedOther))
	}
	if keep == nil {
		keep = []ListEntry{}
	}
	l.Mods = keep
	return &l, notes, nil
}

func checkEntry(e *ListEntry) string {
	if !ValidID(e.ID) {
		return "its id must be lower-case letters, digits, '.', '-' or '_'"
	}
	if strings.TrimSpace(e.Name) == "" || strings.TrimSpace(e.Version) == "" {
		return "it needs a name and a version"
	}
	if len(e.Files) == 0 || len(e.Files) > maxModFiles {
		return fmt.Sprintf("it needs between 1 and %d files", maxModFiles)
	}
	paths := map[string]bool{}
	for i := range e.Files {
		f := &e.Files[i]
		clean, ok := cleanRel(f.Path)
		if !ok {
			return fmt.Sprintf("%q is not a plain path inside the mod's folder", f.Path)
		}
		if !allowedExt[strings.ToLower(path.Ext(clean))] {
			return fmt.Sprintf("%s: GobboNet does not install that kind of file", clean)
		}
		if paths[clean] || clean == manifestName {
			return fmt.Sprintf("%s is listed twice, or is mod.json", clean)
		}
		paths[clean] = true
		f.Path = clean
		if !strings.HasPrefix(f.URL, "https://") {
			return fmt.Sprintf("%s: its url must be https", clean)
		}
		f.SHA256 = strings.ToLower(strings.TrimSpace(f.SHA256))
		if !isHex64(f.SHA256) {
			return fmt.Sprintf("%s has no SHA-256 (64 hex characters); an endorsed file must be pinned", clean)
		}
		if f.Size < 0 || f.Size > maxModFileSize {
			return fmt.Sprintf("%s is larger than %d MB", clean, maxModFileSize>>20)
		}
	}
	return ""
}

func isHex64(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// FetchOptions say where the list is and how to reach it.
type FetchOptions struct {
	URL           string // empty: switched off
	CacheDir      string // where the last good copy is kept
	ClientVersion string
	Client        *http.Client
	Now           func() time.Time
}

type listCache struct {
	FetchedAt time.Time `json:"fetched_at"`
	URL       string    `json:"url"`
	Body      string    `json:"body"`
}

// FetchList gets the list: live if it can, the last good copy if not. The
// notes say which, and why.
func FetchList(o FetchOptions) (*List, []string, error) {
	if strings.TrimSpace(o.URL) == "" {
		return nil, []string{"the endorsed list is switched off (mod_list_url is empty)"}, nil
	}
	now := time.Now
	if o.Now != nil {
		now = o.Now
	}
	var notes []string
	body, err := getBounded(o.Client, o.URL, listTimeout, maxListBytes)
	if err == nil {
		l, more, perr := ParseList(body, o.ClientVersion)
		notes = append(notes, more...)
		if perr == nil {
			l.Source, l.URL = "remote", o.URL
			if o.CacheDir != "" {
				b, _ := json.Marshal(listCache{FetchedAt: now(), URL: o.URL, Body: string(body)})
				_ = os.MkdirAll(o.CacheDir, 0o755)
				_ = atomicfile.Write(filepath.Join(o.CacheDir, listCacheName), b, 0o644)
			}
			return l, notes, nil
		}
		notes = append(notes, perr.Error())
	} else {
		notes = append(notes, "could not reach the endorsed list: "+err.Error())
	}
	if o.CacheDir != "" {
		if b, rerr := os.ReadFile(filepath.Join(o.CacheDir, listCacheName)); rerr == nil {
			var c listCache
			if json.Unmarshal(b, &c) == nil && c.URL == o.URL {
				if l, more, perr := ParseList([]byte(c.Body), o.ClientVersion); perr == nil {
					l.Source, l.URL = "cache", o.URL
					notes = append(notes, more...)
					notes = append(notes, "showing the list as it was on "+c.FetchedAt.Format("2 Jan 2006"))
					return l, notes, nil
				}
			}
		}
	}
	return nil, notes, errors.New("the endorsed list is not available")
}

func getBounded(client *http.Client, url string, timeout time.Duration, limit int64) ([]byte, error) {
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "GobboNet")
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %d", url, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, fmt.Errorf("%s is larger than %d bytes", url, limit)
	}
	return b, nil
}

// ErrNotFromList: a folder of that name exists and was not installed from
// the endorsed list, so installing would overwrite someone's own work.
var ErrNotFromList = errors.New("a mod of that name is already here and did not come from the endorsed list")

// ErrChecksum: a downloaded file did not match its pin.
var ErrChecksum = errors.New("checksum mismatch")

// InstallResult says what Install did.
type InstallResult struct {
	Updated bool   `json:"updated"` // replaced an earlier version
	Enabled bool   `json:"enabled"` // the switch as it now stands
	From    string `json:"from"`    // the version replaced, for an update
}

// InstalledFrom reports the version of id installed from the endorsed list,
// or "" if it is not installed, or ok=false if a folder of that name exists
// but did not come from the list.
func (s *Store) InstalledFrom(id string) (version string, ok bool) {
	raw, err := os.ReadFile(filepath.Join(s.dir, id, manifestName))
	if err != nil {
		if _, serr := os.Stat(filepath.Join(s.dir, id)); serr == nil {
			return "", false
		}
		return "", true
	}
	var m Manifest
	if json.Unmarshal(raw, &m) != nil || m.Origin != "endorsed" {
		return "", false
	}
	if m.Version == "" {
		m.Version = "?"
	}
	return m.Version, true
}

// Install downloads every file of e, checks each against its pin, and only
// then puts the mod in place -- replacing an earlier endorsed install, and
// never a mod of the same name from anywhere else. A new install is switched
// on; an update keeps its switch.
func (s *Store) Install(e ListEntry, listURL string, client *http.Client) (InstallResult, error) {
	var res InstallResult
	if e.Problem != "" {
		return res, errors.New(e.Name + " " + e.Problem)
	}
	if client == nil {
		client = &http.Client{Timeout: fileTimeout}
	}
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return res, err
	}
	tmp, err := os.MkdirTemp(s.dir, ".installing-"+e.ID+"-")
	if err != nil {
		return res, err
	}
	defer os.RemoveAll(tmp) // a no-op once it has been renamed into place

	var total int64
	man := Manifest{ID: e.ID, Name: e.Name, Version: e.Version, Description: e.Description,
		Author: e.Author, Homepage: e.Homepage, Origin: "endorsed", Source: listURL}
	for _, f := range e.Files {
		body, err := getBounded(client, f.URL, fileTimeout, maxModFileSize)
		if err != nil {
			return res, fmt.Errorf("could not download %s for %s: %w", f.Path, e.Name, err)
		}
		total += int64(len(body))
		if total > maxModBytes {
			return res, fmt.Errorf("%s is larger than %d MB in all", e.Name, maxModBytes>>20)
		}
		sum := sha256.Sum256(body)
		if got := hex.EncodeToString(sum[:]); got != f.SHA256 {
			return res, fmt.Errorf("%w: %s's file %s does not match the checksum the endorsed list pins for it, so nothing was installed",
				ErrChecksum, e.Name, f.Path)
		}
		dst := filepath.Join(tmp, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return res, err
		}
		if err := os.WriteFile(dst, body, 0o644); err != nil {
			return res, err
		}
		man.Files = append(man.Files, FileRef{Path: f.Path})
	}
	b, _ := json.MarshalIndent(man, "", "  ")
	if err := os.WriteFile(filepath.Join(tmp, manifestName), append(b, '\n'), 0o644); err != nil {
		return res, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	dst := filepath.Join(s.dir, e.ID)
	if prev, ok := s.InstalledFrom(e.ID); !ok {
		return res, fmt.Errorf("%w: %s. Remove or rename that folder first", ErrNotFromList, e.ID)
	} else if prev != "" {
		res.Updated, res.From = true, prev
		if err := os.MkdirAll(filepath.Join(s.dir, removedDir), 0o755); err != nil {
			return res, err
		}
		if err := os.Rename(dst, filepath.Join(s.dir, removedDir, fmt.Sprintf("%s@%d", e.ID, time.Now().UnixNano()))); err != nil {
			return res, err
		}
	}
	if err := os.Rename(tmp, dst); err != nil {
		return res, err
	}
	st := s.readState()
	if on, had := st.Enabled[e.ID]; had && res.Updated {
		res.Enabled = on // the user's switch, kept
	} else {
		st.Enabled[e.ID] = true // switched on once, at install
		res.Enabled = true
		if err := s.writeState(st); err != nil {
			return res, err
		}
	}
	return res, nil
}
