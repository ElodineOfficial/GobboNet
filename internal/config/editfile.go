package config

// Editing config.toml from CONFIG in the chat page.
//
// The browser gets the file as text and sends back the whole file, comments
// and all: the comments are the documentation (see DefaultTOML), so this
// never re-serialises a parsed document. What it adds around that:
//
//   - Secrets stay on the server. access_secret (the password hash) and
//     llm_api_key are shown as "(hidden)" and put back from the file on save.
//     The password cannot be changed here -- `gobbonet set-password` does
//     that -- and a save that drops or alters it is refused. llm_api_key may
//     be replaced with a new value, but is never sent to the browser.
//   - Nothing is written that would stop the server starting: the text is
//     parsed exactly as Load parses it (types, misspelt keys, ranges), and the
//     same checks serve makes before it runs (server_exe exists, an
//     llm_api_key_file can be read) are made first.
//   - A save is refused if the file changed since it was opened, so another
//     panel's save, a launcher, or a login that upgraded the password hash is
//     never silently overwritten.
//   - The file as it was before the save is kept as <config>.bak, and
//     RestoreBackup puts it back (through the same checks, keeping the
//     current secrets).
//
// Who may do this is the server's decision (internal/server/configfile.go):
// only a browser on this PC.

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"reflect"
	"regexp"
	"sort"
	"strings"

	"github.com/BurntSushi/toml"
	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
)

// HiddenValue stands in for a secret in the text the browser sees.
const HiddenValue = "(hidden)"

// MaxEditBytes bounds what a save may send. The default file is about 12 KB.
const MaxEditBytes = 256 << 10

// secretKeys are hidden from the editor, in the order they appear in the file.
var secretKeys = []string{"llm_api_key", "access_secret"}

var hiddenNote = map[string]string{
	"access_secret": "  # the password hash: kept as it is. Change the password with: gobbonet set-password",
	"llm_api_key":   "  # kept as it is. Replace (hidden) with a new key to change it",
}

// ErrEditConflict means the file changed after the editor read it.
var ErrEditConflict = errors.New("config.toml changed since it was opened")

// EditView is what the editor shows.
type EditView struct {
	Text      string   // the file, secrets hidden
	Version   string   // sha256 of the file as it is on disk
	Hidden    []string // which secret keys were hidden
	HasBackup bool
}

// EditResult describes a save.
type EditResult struct {
	Version  string   // of the file now on disk
	Changed  []string // keys whose value changed; secrets by name only
	Warnings []string // keys this version does not know, ignored when it runs
	Old, New Config   // parsed without the environment, for the caller's own checks
	Raw      []byte   // what was (or would be) written
}

// BackupPath is where the file is kept as it was before the last save.
func BackupPath(path string) string { return path + ".bak" }

func fileVersion(raw []byte) string {
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// rootLine finds the single-line assignment of key above the first table
// header. -1 when absent.
func rootLine(lines []string, key string) int {
	assign := regexp.MustCompile(`^\s*` + regexp.QuoteMeta(key) + `\s*=`)
	header := regexp.MustCompile(`^\s*\[`)
	for i, l := range lines {
		if header.MatchString(l) {
			return -1
		}
		if assign.MatchString(l) {
			return i
		}
	}
	return -1
}

// lineValue reads the value of a one-line `key = value` assignment.
func lineValue(line string) (string, bool) {
	var v map[string]any
	if _, err := toml.Decode(line, &v); err != nil {
		return "", false
	}
	for _, x := range v {
		s, ok := x.(string)
		return s, ok
	}
	return "", false
}

func splitLines(raw []byte) []string {
	var out []string
	sc := bufio.NewScanner(strings.NewReader(string(raw)))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	for sc.Scan() {
		out = append(out, sc.Text())
	}
	return out
}

// redact replaces each non-empty secret with HiddenValue.
func redact(raw []byte) (string, []string, error) {
	lines := splitLines(raw)
	var hidden []string
	for _, key := range secretKeys {
		i := rootLine(lines, key)
		if i < 0 {
			continue
		}
		val, ok := lineValue(lines[i])
		if !ok {
			// A multi-line or non-string value: there is no safe way to show the
			// rest of the file without it.
			return "", nil, fmt.Errorf("%s is not written as a one-line string, so it cannot be hidden safely; edit the file directly", key)
		}
		if val == "" {
			continue
		}
		indent := lines[i][:len(lines[i])-len(strings.TrimLeft(lines[i], " \t"))]
		lines[i] = indent + key + " = " + fmt.Sprintf("%q", HiddenValue) + hiddenNote[key]
		hidden = append(hidden, key)
	}
	return strings.Join(lines, "\n") + "\n", hidden, nil
}

// ReadForEdit returns the file at path for the editor.
func ReadForEdit(path string) (EditView, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return EditView{}, err
	}
	text, hidden, err := redact(raw)
	if err != nil {
		return EditView{}, err
	}
	_, bakErr := os.Stat(BackupPath(path))
	return EditView{Text: text, Version: fileVersion(raw), Hidden: hidden, HasBackup: bakErr == nil}, nil
}

// restoreSecrets puts the file's own secret lines back into edited text.
func restoreSecrets(edited string, current []byte) (string, error) {
	lines := strings.Split(strings.ReplaceAll(edited, "\r\n", "\n"), "\n")
	cur := splitLines(current)
	for _, key := range secretKeys {
		ci := rootLine(cur, key)
		curVal := ""
		if ci >= 0 {
			curVal, _ = lineValue(cur[ci])
		}
		ei := rootLine(lines, key)
		if ei >= 0 {
			if v, ok := lineValue(lines[ei]); ok && v == HiddenValue {
				if ci < 0 {
					return "", fmt.Errorf("%s says %s, but the file has no %s to keep; write a value instead", key, HiddenValue, key)
				}
				lines[ei] = cur[ci]
				continue
			}
		}
		if key == "access_secret" {
			newVal := ""
			if ei >= 0 {
				newVal, _ = lineValue(lines[ei])
			}
			if newVal != curVal {
				if ei < 0 {
					return "", errors.New("keep the access_secret line: it holds your password. Change the password with: gobbonet set-password")
				}
				return "", errors.New("the password cannot be changed here. Leave access_secret as it is and run: gobbonet set-password")
			}
		}
	}
	return strings.Join(lines, "\n"), nil
}

// parseText parses a whole config.toml as Load does, without the
// environment, and makes the checks serve makes before it runs.
func parseText(path string, raw []byte) (Config, []string, error) {
	cfg := Default()
	cfg.Path = path
	md, err := toml.Decode(string(raw), &cfg)
	if err != nil {
		return cfg, nil, err
	}
	var warnings, typos []string
	for _, k := range md.Undecoded() {
		key := k.String()
		if near := nearestKey(key); near != "" {
			typos = append(typos, key+" (did you mean "+near+"?)")
		} else if near := mcpTypo(key); near != "" {
			typos = append(typos, key+" (did you mean "+near+"?)")
		} else if !strings.HasPrefix(key, "ui.") {
			warnings = append(warnings, key)
		}
	}
	if len(typos) > 0 {
		return cfg, nil, fmt.Errorf("unknown setting(s): %s", strings.Join(typos, ", "))
	}
	if err := cfg.normalise(); err != nil {
		return cfg, nil, err
	}
	if _, err := cfg.Mode(); err != nil {
		return cfg, nil, err
	}
	if err := cfg.Runnable(); err != nil {
		return cfg, nil, err
	}
	return cfg, warnings, nil
}

// changedKeys compares two files' settings, top level and [ui].
func changedKeys(oldRaw, newRaw []byte) []string {
	var a, b map[string]any
	toml.Decode(string(oldRaw), &a) //nolint:errcheck // both already parsed
	toml.Decode(string(newRaw), &b) //nolint:errcheck
	flat := func(m map[string]any) map[string]any {
		out := map[string]any{}
		for k, v := range m {
			if t, ok := v.(map[string]any); ok {
				for k2, v2 := range t {
					out[k+"."+k2] = v2
				}
				continue
			}
			out[k] = v
		}
		return out
	}
	fa, fb := flat(a), flat(b)
	seen := map[string]bool{}
	var out []string
	for _, m := range []map[string]any{fa, fb} {
		for k := range m {
			if seen[k] {
				continue
			}
			seen[k] = true
			if !reflect.DeepEqual(fa[k], fb[k]) {
				out = append(out, k)
			}
		}
	}
	sort.Strings(out)
	return out
}

// PrepareEdit checks an edited file against the one on disk without writing
// anything. The caller may make its own checks on the result, then Commit.
func PrepareEdit(path, edited, version string) (EditResult, error) {
	if len(edited) > MaxEditBytes {
		return EditResult{}, fmt.Errorf("config.toml is limited to %d KB here", MaxEditBytes>>10)
	}
	current, err := os.ReadFile(path)
	if err != nil {
		return EditResult{}, err
	}
	if fileVersion(current) != version {
		return EditResult{}, ErrEditConflict
	}
	text, err := restoreSecrets(edited, current)
	if err != nil {
		return EditResult{}, err
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	newCfg, warnings, err := parseText(path, []byte(text))
	if err != nil {
		return EditResult{}, err
	}
	oldCfg, _, _ := parseText(path, current)
	return EditResult{
		Changed:  changedKeys(current, []byte(text)),
		Warnings: warnings,
		Old:      oldCfg,
		New:      newCfg,
		Raw:      []byte(text),
	}, nil
}

// CommitEdit writes a prepared edit, keeping the file it replaces as the
// backup. The version is checked again under the lock that config set uses.
func CommitEdit(path, version string, res EditResult) (EditResult, error) {
	setMu.Lock()
	defer setMu.Unlock()
	current, err := os.ReadFile(path)
	if err != nil {
		return res, err
	}
	if fileVersion(current) != version {
		return res, ErrEditConflict
	}
	if err := atomicfile.Write(BackupPath(path), current, 0o600); err != nil {
		return res, fmt.Errorf("could not keep a copy of the old file: %w", err)
	}
	if err := atomicfile.Write(path, res.Raw, 0o600); err != nil {
		return res, err
	}
	res.Version = fileVersion(res.Raw)
	return res, nil
}

// PrepareRestore prepares putting the backup back, through the same checks
// as an edit. The secrets in the file now are kept: a backup taken before
// `gobbonet set-password` must not bring the old password back.
func PrepareRestore(path, version string) (EditResult, error) {
	bak, err := os.ReadFile(BackupPath(path))
	if err != nil {
		if os.IsNotExist(err) {
			return EditResult{}, errors.New("there is no earlier version to go back to")
		}
		return EditResult{}, err
	}
	text, _, err := redact(bak)
	if err != nil {
		return EditResult{}, err
	}
	return PrepareEdit(path, text, version)
}
