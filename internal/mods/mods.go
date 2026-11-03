// Package mods keeps the chat page's mods: named units of CSS and JavaScript,
// each a folder on the PC running GobboNet, each with its own switch (1.7.9,
// F1).
//
// # Layout
//
//	<data_dir>/mods/<id>/mod.json      the manifest (id, name, version, files)
//	<data_dir>/mods/<id>/...           the files it lists
//	<data_dir>/mods/mods-state.json    the switches and the load order
//	<data_dir>/mods/.removed/          removed mods, until UNDO or the next start
//
// The switches live apart from the manifests on purpose: replacing a mod's
// files (an update, or editing My extensions) never changes whether it is on.
//
// # Who may do what
//
// Mods are code that runs in every browser that opens this GobboNet. So
// anything that can make code run -- writing a mod, switching one on,
// reordering, removing, importing -- is for a browser on this PC only, which
// the server checks (internal/server/mods.go). Any signed-in device may read
// the list and switch a mod OFF. A folder dropped in by hand starts off.
//
// # Why not in /state any more
//
// Before 1.7.9 the page's extensions were one blob inside the synced chat
// state, which any paired device can overwrite. Mods are not in /state at
// all, so a device cannot push code to another by syncing.
package mods

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
)

const (
	// MyExtensionsID is the mod the old extensions panel became: the raw
	// CSS/JS editor writes here.
	MyExtensionsID = "my-extensions"
	manifestName   = "mod.json"
	stateName      = "mods-state.json"
	removedDir     = ".removed"
	maxMods        = 200
	maxFileBytes   = 2 << 20 // one stylesheet or script from the editor
	defaultOrder   = 100
)

var idRe = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{0,63}$`)

// ValidID reports whether id can name a mod folder.
func ValidID(id string) bool { return idRe.MatchString(id) && !strings.Contains(id, "..") }

// FileRef is one thing a mod loads or ships: a file in its folder, or (for
// the old extensions' URL entries) an address.
type FileRef struct {
	Path string `json:"path,omitempty"`
	URL  string `json:"url,omitempty"`
	Type string `json:"type,omitempty"` // "css", "js", or "asset" (served, not loaded)
	Name string `json:"name,omitempty"`
	Size int64  `json:"size,omitempty"`
}

// UnmarshalJSON takes "style.css" as shorthand for {"path": "style.css"}.
func (f *FileRef) UnmarshalJSON(b []byte) error {
	var s string
	if err := json.Unmarshal(b, &s); err == nil {
		*f = FileRef{Path: s}
		return nil
	}
	type plain FileRef
	var p plain
	if err := json.Unmarshal(b, &p); err != nil {
		return err
	}
	*f = FileRef(p)
	return nil
}

// Manifest is mod.json.
type Manifest struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Version     string    `json:"version,omitempty"`
	Description string    `json:"description,omitempty"`
	Author      string    `json:"author,omitempty"`
	Homepage    string    `json:"homepage,omitempty"`
	Order       int       `json:"order,omitempty"` // lower loads first; 100 if absent
	Files       []FileRef `json:"files"`
	// Origin says who manages the folder: "editor" (My extensions and the
	// like: GobboNet rewrites it on SAVE), "legacy" (imported from the old
	// extensions), "endorsed" (installed from the endorsed list), or empty
	// (made by hand: GobboNet never rewrites it).
	Origin string `json:"origin,omitempty"`
	// Source is the endorsed list an endorsed mod was installed from (1.7.9,
	// F6), so the list can tell it is installed and offer an update.
	Source string `json:"source,omitempty"`
}

// Mod is a manifest as found on disk, with its switch.
type Mod struct {
	Manifest
	Enabled  bool   `json:"enabled"`
	Position int    `json:"position"` // 0-based place in the load order
	Hash     string `json:"hash"`     // changes when any file does; for cache-busting URLs
	Error    string `json:"error,omitempty"`
	dir      string
}

// Entry is one stylesheet or script in the editor's shape -- the old
// extensions' shape, so the editor and the migration share it.
type Entry struct {
	Name string `json:"name"`
	URL  string `json:"url"`
	Raw  string `json:"raw"`
}

// Source is an editor-managed mod's content.
type Source struct {
	Name    string  `json:"name"`
	Styles  []Entry `json:"styles"`
	Scripts []Entry `json:"scripts"`
}

type stateFile struct {
	Enabled map[string]bool `json:"enabled"`
	Order   []string        `json:"order,omitempty"`
}

// Store is the mods folder.
type Store struct {
	dir string
	mu  sync.Mutex
}

// Open returns the store at dir (normally <data_dir>/mods). It is created on
// first write, not here.
func Open(dir string) *Store { return &Store{dir: dir} }

// Dir is the folder mods live in.
func (s *Store) Dir() string { return s.dir }

var (
	ErrNotFound      = errors.New("no such mod")
	ErrBroken        = errors.New("this mod cannot load")
	ErrNotEditable   = errors.New("this mod was made by hand; edit its folder instead")
	ErrNothingToUndo = errors.New("nothing to put back")
)

func (s *Store) readState() stateFile {
	st := stateFile{Enabled: map[string]bool{}}
	b, err := os.ReadFile(filepath.Join(s.dir, stateName))
	if err == nil {
		_ = json.Unmarshal(b, &st)
	}
	if st.Enabled == nil {
		st.Enabled = map[string]bool{}
	}
	return st
}

func (s *Store) writeState(st stateFile) error {
	if err := os.MkdirAll(s.dir, 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(st, "", "  ")
	return atomicfile.Write(filepath.Join(s.dir, stateName), append(b, '\n'), 0o644)
}

// List reads every mod, in load order.
func (s *Store) List() []Mod {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listLocked()
}

func (s *Store) listLocked() []Mod {
	entries, err := os.ReadDir(s.dir)
	if err != nil {
		return nil
	}
	st := s.readState()
	var out []Mod
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || len(out) >= maxMods {
			continue
		}
		m := s.load(e.Name())
		m.Enabled = m.Error == "" && st.Enabled[m.ID]
		out = append(out, m)
	}
	pos := map[string]int{}
	for i, id := range st.Order {
		pos[id] = i
	}
	rank := func(m Mod) int {
		if p, ok := pos[m.ID]; ok {
			return p
		}
		return len(st.Order)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if a, b := rank(out[i]), rank(out[j]); a != b {
			return a < b
		}
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].ID < out[j].ID
	})
	for i := range out {
		out[i].Position = i
	}
	return out
}

// load reads one folder's manifest and checks every file it names.
func (s *Store) load(folder string) Mod {
	m := Mod{dir: filepath.Join(s.dir, folder)}
	m.ID = folder
	m.Name = folder
	raw, err := os.ReadFile(filepath.Join(m.dir, manifestName))
	if err != nil {
		m.Error = "no mod.json in this folder"
		return m
	}
	var man Manifest
	if err := json.Unmarshal(raw, &man); err != nil {
		m.Error = "mod.json is not valid JSON: " + err.Error()
		return m
	}
	if man.ID == "" {
		man.ID = folder
	}
	if man.Name == "" {
		man.Name = man.ID
	}
	if man.Order == 0 {
		man.Order = defaultOrder
	}
	m.Manifest = man
	m.ID = folder // the folder is the identity, whatever the manifest says
	if !ValidID(folder) {
		m.Error = "the folder name must be lower-case letters, digits, '.', '-' or '_'"
		return m
	}
	if man.ID != folder {
		m.Error = fmt.Sprintf("mod.json says id %q but the folder is %q", man.ID, folder)
		return m
	}
	h := sha256.New()
	h.Write(raw)
	for i := range m.Files {
		f := &m.Files[i]
		if f.URL != "" {
			if f.Path != "" {
				m.Error = "a file entry has both a path and a url"
				return m
			}
			if !strings.HasPrefix(f.URL, "https://") && !strings.HasPrefix(f.URL, "http://") {
				m.Error = "a url must start with http:// or https://"
				return m
			}
			if f.Type != "css" && f.Type != "js" {
				m.Error = "a url entry needs \"type\": \"css\" or \"js\""
				return m
			}
			continue
		}
		clean, ok := cleanRel(f.Path)
		if !ok {
			m.Error = fmt.Sprintf("%q is not a plain path inside the mod's folder", f.Path)
			return m
		}
		f.Path = clean
		fi, err := os.Lstat(filepath.Join(m.dir, filepath.FromSlash(clean)))
		if err != nil || !fi.Mode().IsRegular() {
			m.Error = fmt.Sprintf("%s is missing (or is a link, which mods may not use)", clean)
			return m
		}
		f.Size = fi.Size()
		if f.Type == "" {
			f.Type = typeOf(clean)
		}
		fmt.Fprintf(h, "%s:%d:%d;", clean, fi.Size(), fi.ModTime().UnixNano())
	}
	m.Hash = hex.EncodeToString(h.Sum(nil))[:12]
	return m
}

// cleanRel accepts a plain relative path inside a folder: no "..", no
// leading "/", no backslashes, no hidden segments.
func cleanRel(p string) (string, bool) {
	if p == "" || strings.ContainsRune(p, '\\') || strings.HasPrefix(p, "/") || strings.ContainsRune(p, 0) {
		return "", false
	}
	c := path.Clean(p)
	if c == "." || c == ".." || strings.HasPrefix(c, "../") {
		return "", false
	}
	for _, seg := range strings.Split(c, "/") {
		if seg == "" || strings.HasPrefix(seg, ".") {
			return "", false
		}
	}
	return c, true
}

func typeOf(p string) string {
	switch strings.ToLower(path.Ext(p)) {
	case ".css":
		return "css"
	case ".js", ".mjs":
		return "js"
	}
	return "asset"
}

// Get returns one mod.
func (s *Store) Get(id string) (Mod, error) {
	for _, m := range s.List() {
		if m.ID == id {
			return m, nil
		}
	}
	return Mod{}, ErrNotFound
}

// File resolves a file a mod lists, for serving. Only listed files are
// served, and only regular files inside the mod's folder.
func (s *Store) File(id, rel string) (string, error) {
	if !ValidID(id) {
		return "", ErrNotFound
	}
	m, err := s.Get(id)
	if err != nil || m.Error != "" {
		return "", ErrNotFound
	}
	clean, ok := cleanRel(rel)
	if !ok {
		return "", ErrNotFound
	}
	for _, f := range m.Files {
		if f.Path == clean {
			full := filepath.Join(m.dir, filepath.FromSlash(clean))
			if fi, err := os.Lstat(full); err == nil && fi.Mode().IsRegular() {
				return full, nil
			}
		}
	}
	return "", ErrNotFound
}

// SetEnabled flips one switch. A broken mod cannot be switched on.
func (s *Store) SetEnabled(id string, on bool) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	var found *Mod
	list := s.listLocked()
	for i := range list {
		if list[i].ID == id {
			found = &list[i]
		}
	}
	if found == nil {
		return ErrNotFound
	}
	if on && found.Error != "" {
		return fmt.Errorf("%w: %s", ErrBroken, found.Error)
	}
	st := s.readState()
	st.Enabled[id] = on
	return s.writeState(st)
}

// Move shifts a mod earlier (delta < 0) or later in the load order.
func (s *Store) Move(id string, delta int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	list := s.listLocked()
	at := -1
	for i, m := range list {
		if m.ID == id {
			at = i
		}
	}
	if at < 0 {
		return ErrNotFound
	}
	to := at + delta
	if to < 0 {
		to = 0
	}
	if to > len(list)-1 {
		to = len(list) - 1
	}
	ids := make([]string, 0, len(list))
	for _, m := range list {
		ids = append(ids, m.ID)
	}
	moved := ids[at]
	ids = append(ids[:at], ids[at+1:]...)
	ids = append(ids[:to], append([]string{moved}, ids[to:]...)...)
	st := s.readState()
	st.Order = ids
	return s.writeState(st)
}

// Source returns an editor-managed mod's content as the editor shows it.
// A hand-made mod is read too (for viewing), but cannot be written back.
func (s *Store) Source(id string) (Source, error) {
	m, err := s.Get(id)
	if err != nil {
		return Source{}, err
	}
	src := Source{Name: m.Name, Styles: []Entry{}, Scripts: []Entry{}}
	for _, f := range m.Files {
		e := Entry{Name: f.Name, URL: f.URL}
		if f.Path != "" {
			b, err := os.ReadFile(filepath.Join(m.dir, filepath.FromSlash(f.Path)))
			if err != nil {
				continue
			}
			e.Raw = string(b)
		}
		switch f.Type {
		case "css":
			src.Styles = append(src.Styles, e)
		case "js":
			src.Scripts = append(src.Scripts, e)
		}
	}
	return src, nil
}

// WriteSource saves an editor-managed mod, creating it if needed. Its switch
// is left as it was (a new mod starts off unless enable says otherwise).
// Each entry becomes its own file -- style-1.css, script-1.js -- and URL
// entries stay URL entries.
func (s *Store) WriteSource(id string, src Source, origin string, enable *bool) error {
	if !ValidID(id) {
		return fmt.Errorf("%q is not a valid mod id", id)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	dir := filepath.Join(s.dir, id)
	if raw, err := os.ReadFile(filepath.Join(dir, manifestName)); err == nil {
		var old Manifest
		if json.Unmarshal(raw, &old) == nil && old.Origin != "editor" && old.Origin != "legacy" {
			return ErrNotEditable
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	man := Manifest{ID: id, Name: strings.TrimSpace(src.Name), Version: "1", Origin: origin}
	if man.Name == "" {
		man.Name = id
	}
	if origin == "" {
		man.Origin = "editor"
	}
	keep := map[string]bool{manifestName: true}
	add := func(kind string, i int, e Entry) error {
		name := strings.TrimSpace(e.Name)
		url := strings.TrimSpace(e.URL)
		if url != "" {
			if !strings.HasPrefix(url, "https://") && !strings.HasPrefix(url, "http://") {
				return fmt.Errorf("%q: a URL must start with http:// or https://", url)
			}
			man.Files = append(man.Files, FileRef{URL: url, Type: kind, Name: name})
		}
		if strings.TrimSpace(e.Raw) != "" {
			if len(e.Raw) > maxFileBytes {
				return fmt.Errorf("%s is larger than %d MB", nameOr(name, kind), maxFileBytes>>20)
			}
			ext := map[string]string{"css": "css", "js": "js"}[kind]
			file := fmt.Sprintf("%s-%d.%s", map[string]string{"css": "style", "js": "script"}[kind], i+1, ext)
			if err := atomicfile.Write(filepath.Join(dir, file), []byte(e.Raw), 0o644); err != nil {
				return err
			}
			keep[file] = true
			man.Files = append(man.Files, FileRef{Path: file, Type: kind, Name: name})
		}
		return nil
	}
	for i, e := range src.Styles {
		if err := add("css", i, e); err != nil {
			return err
		}
	}
	for i, e := range src.Scripts {
		if err := add("js", i, e); err != nil {
			return err
		}
	}
	if man.Files == nil {
		man.Files = []FileRef{}
	}
	b, _ := json.MarshalIndent(man, "", "  ")
	if err := atomicfile.Write(filepath.Join(dir, manifestName), append(b, '\n'), 0o644); err != nil {
		return err
	}
	// Drop the files this editor wrote last time and no longer lists.
	if entries, err := os.ReadDir(dir); err == nil {
		for _, e := range entries {
			n := e.Name()
			if !keep[n] && (strings.HasPrefix(n, "style-") || strings.HasPrefix(n, "script-")) {
				_ = os.Remove(filepath.Join(dir, n))
			}
		}
	}
	if enable != nil {
		st := s.readState()
		st.Enabled[id] = *enable
		return s.writeState(st)
	}
	return nil
}

func nameOr(name, kind string) string {
	if name != "" {
		return name
	}
	return map[string]string{"css": "a stylesheet", "js": "a script"}[kind]
}

// ImportLegacy turns the pre-1.7.9 extensions blob into a mod: My
// extensions, or "My extensions (2)" and so on when that already holds
// something different. Importing the same content twice is a no-op. Returns
// the id it landed in.
func (s *Store) ImportLegacy(src Source, enabled bool) (string, bool, error) {
	norm := func(x Source) []byte {
		x.Name = ""
		for _, l := range [][]Entry{x.Styles, x.Scripts} {
			for i := range l {
				l[i].Name = strings.TrimSpace(l[i].Name)
				l[i].URL = strings.TrimSpace(l[i].URL)
			}
		}
		b, _ := json.Marshal(x)
		return b
	}
	src.Styles = live(src.Styles)
	src.Scripts = live(src.Scripts)
	if len(src.Styles)+len(src.Scripts) == 0 {
		return "", false, nil
	}
	for n := 1; n <= 50; n++ {
		id, name := MyExtensionsID, "My extensions"
		if n > 1 {
			id, name = fmt.Sprintf("%s-%d", MyExtensionsID, n), fmt.Sprintf("My extensions (%d)", n)
		}
		existing, err := s.Source(id)
		if errors.Is(err, ErrNotFound) {
			src.Name = name
			on := enabled
			if err := s.WriteSource(id, src, "legacy", &on); err != nil {
				return "", false, err
			}
			return id, true, nil
		}
		if err == nil && bytes.Equal(norm(existing), norm(src)) {
			return id, false, nil
		}
	}
	return "", false, errors.New("too many imported extension sets")
}

func live(l []Entry) []Entry {
	out := []Entry{}
	for _, e := range l {
		if strings.TrimSpace(e.URL) != "" || strings.TrimSpace(e.Raw) != "" {
			out = append(out, e)
		}
	}
	return out
}

// Remove moves a mod aside, so UNDO can put it back until the next start.
func (s *Store) Remove(id string) error {
	if !ValidID(id) {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	src := filepath.Join(s.dir, id)
	if fi, err := os.Stat(src); err != nil || !fi.IsDir() {
		return ErrNotFound
	}
	if err := os.MkdirAll(filepath.Join(s.dir, removedDir), 0o755); err != nil {
		return err
	}
	dst := filepath.Join(s.dir, removedDir, fmt.Sprintf("%s@%d", id, time.Now().UnixNano()))
	return os.Rename(src, dst)
}

// Restore puts the most recently removed copy of id back.
func (s *Store) Restore(id string) error {
	if !ValidID(id) {
		return ErrNotFound
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := os.Stat(filepath.Join(s.dir, id)); err == nil {
		return fmt.Errorf("a mod called %s is already there", id)
	}
	entries, _ := os.ReadDir(filepath.Join(s.dir, removedDir))
	latest := ""
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), id+"@") && e.Name() > latest {
			latest = e.Name()
		}
	}
	if latest == "" {
		return ErrNothingToUndo
	}
	return os.Rename(filepath.Join(s.dir, removedDir, latest), filepath.Join(s.dir, id))
}

// PurgeRemoved deletes what Remove set aside. Called once at start-up: by
// then no page can still be offering UNDO for it.
func (s *Store) PurgeRemoved() {
	s.mu.Lock()
	defer s.mu.Unlock()
	_ = os.RemoveAll(filepath.Join(s.dir, removedDir))
	// An install interrupted by a crash or a power cut leaves its download
	// folder behind; it was never put in place, so it goes too.
	if left, err := filepath.Glob(filepath.Join(s.dir, ".installing-*")); err == nil {
		for _, d := range left {
			_ = os.RemoveAll(d)
		}
	}
	// Forget the switches and places of mods that are no longer there.
	st := s.readState()
	changed := false
	exists := func(id string) bool {
		fi, err := os.Stat(filepath.Join(s.dir, id))
		return err == nil && fi.IsDir()
	}
	for id := range st.Enabled {
		if !exists(id) {
			delete(st.Enabled, id)
			changed = true
		}
	}
	kept := st.Order[:0]
	for _, id := range st.Order {
		if exists(id) {
			kept = append(kept, id)
		} else {
			changed = true
		}
	}
	st.Order = kept
	if changed {
		_ = s.writeState(st)
	}
}
