// Package localmodels finds GGUF models already on this computer -- in the
// HuggingFace cache and in any folders listed in model_dirs -- and links one
// into the models folder when the user picks it (1.7.9, issue #12).
//
// # Why link, never copy
//
// The point of the feature is that the user already has the file. A 20 GB
// copy would double the disk it uses and take minutes; a link is instant and
// costs nothing. On Linux and macOS it is a symbolic link. On Windows it is a
// hard link, which needs no administrator rights or Developer Mode, with a
// symbolic link as the fallback; a hard link cannot cross drives, and when
// neither works the error says so in words.
//
// # Why the models folder stays the one source of truth
//
// Everything downstream -- the header dropdown, the swap, the supervisor that
// launches llama-server -- names a model by its file name inside model_dir.
// A link there makes a found model indistinguishable from a downloaded one,
// so none of that code needed to learn about other folders, and none of its
// path checks were loosened.
//
// # Privacy and safety
//
// It reads folders on this machine and nothing else, and only when asked
// (the Add a Model window). The browser never names a path: it is handed an
// ID for each model found, and Link re-scans and resolves that ID itself.
// The walk is bounded in depth, entries and time, so a model_dirs entry
// pointing at a whole drive costs a few seconds, not a hang.
package localmodels

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/models"
)

// Root is one place to look.
type Root struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`   // "hf-cache" or "folder"
	Source string `json:"source"` // where the path came from: HF_HUB_CACHE, model_dirs, ...
	Exists bool   `json:"exists"`
}

// Found is one model found outside the models folder.
type Found struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"` // what to show: the file, or the split prefix
	File      string   `json:"file"` // what lands in model_dir: the (first) part's name
	Path      string   `json:"path"` // where it is
	Parts     []string `json:"-"`    // every part's path, first first
	SizeBytes int64    `json:"sizeBytes"`
	PartCount int      `json:"parts"`
	Repo      string   `json:"repo,omitempty"` // "org/name", from a HuggingFace cache path
	Kind      string   `json:"kind"`
	Root      string   `json:"root"`
	// State is "new", "linked" (already in the models folder: this very file)
	// or "name-taken" (a different file of that name is already there).
	State string `json:"state"`
}

// Limits bound a scan. Zero values take the defaults.
type Limits struct {
	MaxDepth   int
	MaxEntries int
	MaxTime    time.Duration
}

func (l Limits) orDefaults() Limits {
	if l.MaxDepth <= 0 {
		l.MaxDepth = 6 // hub/models--org--name/snapshots/<rev>/<sub>/<file>
	}
	if l.MaxEntries <= 0 {
		l.MaxEntries = 50000
	}
	if l.MaxTime <= 0 {
		l.MaxTime = 4 * time.Second
	}
	return l
}

// Roots lists where to look: the HuggingFace cache (if scanHF), then every
// model_dirs entry. getenv and home are injected for tests.
//
// The cache is HuggingFace's own rule: HF_HUB_CACHE if set, else HF_HOME/hub,
// else ~/.cache/huggingface/hub. All three are offered when they differ and
// exist, since tools disagree about which variable they honour and a user
// may have files under more than one.
func Roots(modelDirs []string, scanHF bool, getenv func(string) string, home string) []Root {
	var out []Root
	seen := map[string]bool{}
	add := func(p, kind, source string) {
		if p == "" {
			return
		}
		p = expandHome(p, home)
		if abs, err := filepath.Abs(p); err == nil {
			p = abs
		}
		p = filepath.Clean(p)
		key := p
		if runtime.GOOS == "windows" {
			key = strings.ToLower(p)
		}
		if seen[key] {
			return
		}
		seen[key] = true
		st, err := os.Stat(p)
		out = append(out, Root{Path: p, Kind: kind, Source: source, Exists: err == nil && st.IsDir()})
	}
	if scanHF {
		add(getenv("HF_HUB_CACHE"), "hf-cache", "HF_HUB_CACHE")
		if h := getenv("HF_HOME"); h != "" {
			add(filepath.Join(h, "hub"), "hf-cache", "HF_HOME")
		}
		if home != "" {
			add(filepath.Join(home, ".cache", "huggingface", "hub"), "hf-cache", "default")
		}
	}
	for _, d := range modelDirs {
		add(strings.TrimSpace(d), "folder", "model_dirs")
	}
	return out
}

func expandHome(p, home string) string {
	if home == "" {
		return p
	}
	if p == "~" {
		return home
	}
	if strings.HasPrefix(p, "~/") || strings.HasPrefix(p, `~\`) {
		return filepath.Join(home, p[2:])
	}
	return p
}

var ggufRe = regexp.MustCompile(`(?i)\.gguf$`)

// hfRepoRe pulls "org/name" out of a cache path: hub/models--org--name/...
var hfRepoRe = regexp.MustCompile(`(?:^|[/\\])models--([^/\\]+?)--([^/\\]+)(?:[/\\]|$)`)

// ID is the stable handle the browser sends back: a hash of where the file
// really is, so it names this model and nothing the page could choose.
func ID(realPath string) string {
	sum := sha256.Sum256([]byte(realPath))
	return hex.EncodeToString(sum[:8])
}

// Scan walks the roots and returns every chat model found, sorted, and notes
// on anything cut short. modelDir is skipped (its models are already listed)
// and is what State is judged against.
func Scan(roots []Root, modelDir string, lim Limits) ([]Found, []string) {
	lim = lim.orDefaults()
	var notes []string
	deadline := time.Now().Add(lim.MaxTime)
	entries := 0
	stopped := false

	modelDirAbs := ""
	if modelDir != "" {
		if a, err := filepath.Abs(modelDir); err == nil {
			modelDirAbs = filepath.Clean(a)
		}
	}
	type cand struct {
		path string
		root Root
	}
	var files []cand

	for _, root := range roots {
		if !root.Exists || stopped {
			continue
		}
		base := strings.Count(root.Path, string(os.PathSeparator))
		_ = filepath.WalkDir(root.Path, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				if d != nil && d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			entries++
			if entries > lim.MaxEntries || time.Now().After(deadline) {
				stopped = true
				return fs.SkipAll
			}
			if d.IsDir() {
				if p == root.Path {
					return nil
				}
				name := d.Name()
				if strings.HasPrefix(name, ".") || name == "blobs" || name == "node_modules" {
					return fs.SkipDir
				}
				if modelDirAbs != "" && sameDir(p, modelDirAbs) {
					return fs.SkipDir
				}
				if strings.Count(p, string(os.PathSeparator))-base >= lim.MaxDepth {
					return fs.SkipDir
				}
				return nil
			}
			if !ggufRe.MatchString(d.Name()) {
				return nil
			}
			files = append(files, cand{p, root})
			return nil
		})
	}
	if stopped {
		notes = append(notes, fmt.Sprintf(
			"Stopped looking after %d entries or %s; a folder in model_dirs may be too broad.",
			lim.MaxEntries, lim.MaxTime))
	}

	// Group split parts by folder and prefix; keep whole files as they are.
	type splitKey struct{ dir, prefix string }
	splits := map[splitKey]map[int]string{}
	splitTotal := map[splitKey]int{}
	splitRoot := map[splitKey]Root{}
	var singles []cand
	for _, c := range files {
		if prefix, part, total, ok := models.SplitPart(filepath.Base(c.path)); ok {
			k := splitKey{filepath.Dir(c.path), prefix}
			if splits[k] == nil {
				splits[k] = map[int]string{}
			}
			splits[k][part] = c.path
			splitTotal[k] = total
			splitRoot[k] = c.root
			continue
		}
		singles = append(singles, c)
	}

	var out []Found
	seenReal := map[string]bool{}
	consider := func(parts []string, root Root, name string) {
		var size int64
		for _, p := range parts {
			st, err := os.Stat(p) // follows links; a dangling one fails here
			if err != nil || !st.Mode().IsRegular() {
				return
			}
			size += st.Size()
		}
		real, err := filepath.EvalSymlinks(parts[0])
		if err != nil {
			return
		}
		if seenReal[real] {
			return // the same file under two revisions, or two roots
		}
		if modelDirAbs != "" && strings.HasPrefix(real, modelDirAbs+string(os.PathSeparator)) {
			return
		}
		if !models.ChatCapable(parts[0]) {
			return
		}
		seenReal[real] = true
		f := Found{
			ID:        ID(real),
			Name:      name,
			File:      filepath.Base(parts[0]),
			Path:      parts[0],
			Parts:     parts,
			SizeBytes: size,
			PartCount: len(parts),
			Kind:      root.Kind,
			Root:      root.Path,
		}
		if m := hfRepoRe.FindStringSubmatch(parts[0]); m != nil && root.Kind == "hf-cache" {
			f.Repo = m[1] + "/" + m[2]
		}
		f.State = state(f, modelDir)
		out = append(out, f)
	}
	for _, c := range singles {
		consider([]string{c.path}, c.root, filepath.Base(c.path))
	}
	for k, got := range splits {
		total := splitTotal[k]
		parts := make([]string, 0, total)
		for i := 1; i <= total; i++ {
			p, ok := got[i]
			if !ok {
				parts = nil
				break
			}
			parts = append(parts, p)
		}
		if parts == nil {
			continue // a split model with a part missing cannot load
		}
		consider(parts, splitRoot[k], fmt.Sprintf("%s (%d parts)", k.prefix+".gguf", total))
	}

	// Alphabetical by what the row shows first: the repo for a cached model,
	// the file name otherwise.
	key := func(f Found) string {
		if f.Repo != "" {
			return strings.ToLower(f.Repo + "/" + f.Name)
		}
		return strings.ToLower(f.Name)
	}
	sort.Slice(out, func(i, j int) bool {
		a, b := key(out[i]), key(out[j])
		if a != b {
			return a < b
		}
		return out[i].Path < out[j].Path
	})
	return out, notes
}

func sameDir(a, b string) bool {
	if filepath.Clean(a) == filepath.Clean(b) {
		return true
	}
	sa, err1 := os.Stat(a)
	sb, err2 := os.Stat(b)
	return err1 == nil && err2 == nil && os.SameFile(sa, sb)
}

// state judges f against what is already in the models folder.
func state(f Found, modelDir string) string {
	if modelDir == "" {
		return "new"
	}
	dest := filepath.Join(modelDir, f.File)
	if _, err := os.Lstat(dest); err != nil {
		return "new"
	}
	a, err1 := os.Stat(dest)
	b, err2 := os.Stat(f.Path)
	if err1 == nil && err2 == nil && os.SameFile(a, b) {
		return "linked"
	}
	return "name-taken"
}

// ErrNameTaken: a different file with this name is already in the models folder.
var ErrNameTaken = errors.New("name taken")

// Link puts every part of f into modelDir as a link. It returns how
// ("symlink" or "hard link"). Already-linked parts are left alone; on failure
// anything this call created is removed again.
func Link(f Found, modelDir string) (string, error) {
	if modelDir == "" {
		return "", errors.New("no models folder is configured")
	}
	if err := os.MkdirAll(modelDir, 0o755); err != nil {
		return "", fmt.Errorf("could not create the models folder %s: %w", modelDir, err)
	}
	var made []string
	undo := func() {
		for _, p := range made {
			_ = os.Remove(p)
		}
	}
	method := ""
	for _, part := range f.Parts {
		st, err := os.Stat(part)
		if err != nil || !st.Mode().IsRegular() || !ggufRe.MatchString(part) {
			undo()
			return "", fmt.Errorf("%s is no longer there", part)
		}
		dest := filepath.Join(modelDir, filepath.Base(part))
		if _, err := os.Lstat(dest); err == nil {
			if d, err := os.Stat(dest); err == nil && os.SameFile(d, st) {
				continue // already linked
			}
			undo()
			return "", fmt.Errorf("%w: %s is already in your models folder and is a different file",
				ErrNameTaken, filepath.Base(part))
		}
		how, err := link(part, dest)
		if err != nil {
			undo()
			return "", err
		}
		made = append(made, dest)
		method = how
	}
	if method == "" {
		method = "already linked"
	}
	return method, nil
}

// link makes one link, the way that works on this system.
func link(src, dest string) (string, error) {
	abs, err := filepath.Abs(src)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		// Hard link first: no Developer Mode or administrator needed. It points
		// at the data itself, so resolve any symlink in the cache first.
		real := abs
		if r, err := filepath.EvalSymlinks(abs); err == nil {
			real = r
		}
		hardErr := os.Link(real, dest)
		if hardErr == nil {
			return "hard link", nil
		}
		if symErr := os.Symlink(real, dest); symErr == nil {
			return "symlink", nil
		}
		return "", fmt.Errorf("could not link %s into your models folder: it is probably on a "+
			"different drive, and Windows only allows a link across drives with Developer Mode "+
			"on. Turn on Developer Mode, or move or copy the file into your models folder "+
			"yourself (%v)", filepath.Base(src), hardErr)
	}
	symErr := os.Symlink(abs, dest)
	if symErr == nil {
		return "symlink", nil
	}
	if err := os.Link(abs, dest); err == nil {
		return "hard link", nil
	}
	return "", fmt.Errorf("could not link %s into your models folder (%v)", filepath.Base(src), symErr)
}
