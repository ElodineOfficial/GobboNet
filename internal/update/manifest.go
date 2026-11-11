package update

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
)

// The two files a release carries for the updater, by name.
const (
	ManifestName  = "gobbonet-update.json"
	SignatureName = "gobbonet-update.json.sig"
)

// ManifestFormat is the update file's format number. A file with another
// number is skipped rather than half-understood.
const ManifestFormat = 1

// Product is what every update file must say it is for, so that a signed file
// for something else the same key might one day sign can never install here.
const Product = "gobbonet"

// Bounds on what is read. The real files are a few hundred bytes.
const (
	maxManifestBytes  = 64 << 10
	maxSignatureBytes = 1 << 10
	// maxAssetBytes covers the largest thing a target may name: an AppImage
	// with the engine inside is the biggest, at a few hundred MB.
	maxAssetBytes = 1 << 30
	// maxMemberBytes covers the program file itself (about 20 MB today).
	maxMemberBytes = 256 << 20
	maxNotesChars  = 4000
)

// Manifest is gobbonet-update.json.
type Manifest struct {
	Format  int    `json:"format"`
	Product string `json:"product"`
	// Version is the release number, "1.8.0"; Build the full stamp the new
	// program reports, "1.8.0-go-abc1234"; Serial its commit time.
	Version string `json:"version"`
	Build   string `json:"build"`
	Serial  int64  `json:"serial"`
	// Published is when the update file was made, RFC 3339. Shown only.
	Published string `json:"published,omitempty"`
	// Notes is a short description shown before installing; NotesURL a page
	// with the full release notes.
	Notes    string `json:"notes,omitempty"`
	NotesURL string `json:"notes_url,omitempty"`
	// Targets maps a platform ("windows-amd64", "linux-amd64",
	// "appimage-amd64") to what to download for it.
	Targets map[string]Target `json:"targets"`
}

// Target is one platform's download.
type Target struct {
	// Asset is the name of a file attached to the same release.
	Asset  string `json:"asset"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
	// Member is the program's path inside the asset when the asset is an
	// archive (.zip, .tar.gz); empty when the asset is the program itself (an
	// AppImage).
	Member       string `json:"member,omitempty"`
	MemberSize   int64  `json:"member_size,omitempty"`
	MemberSHA256 string `json:"member_sha256,omitempty"`
}

// Of is the manifest's build identity.
func (m Manifest) Of() Build { return Build{Version: m.Version, Build: m.Build, Serial: m.Serial} }

var (
	sha256Re    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	assetNameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$`)
	targetKeyRe = regexp.MustCompile(`^[a-z0-9]+-[a-z0-9]+$`)
)

// ParseManifest reads and checks an update file. It is only ever called on
// bytes whose signature has already been checked; the checks here are about a
// maintainer's mistake, not an attacker's file.
func ParseManifest(raw []byte) (Manifest, error) {
	var m Manifest
	if len(raw) > maxManifestBytes {
		return m, errors.New("the update file is too large")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return m, fmt.Errorf("the update file is not valid: %v", err)
	}
	if m.Format != ManifestFormat {
		return m, fmt.Errorf("the update file is format %d; this build reads format %d", m.Format, ManifestFormat)
	}
	if m.Product != Product {
		return m, fmt.Errorf("the update file is for %q, not %s", m.Product, Product)
	}
	if _, ok := ParseBase(m.Version); !ok {
		return m, fmt.Errorf("the update file's version %q is not a release number", m.Version)
	}
	if b, _ := ParseBase(m.Build); CompareBase(b, mustBase(m.Version)) != 0 || !strings.HasPrefix(m.Build, m.Version) {
		return m, fmt.Errorf("the update file's build %q is not a build of %s", m.Build, m.Version)
	}
	if m.Serial <= 0 {
		return m, errors.New("the update file has no serial")
	}
	if len(m.Notes) > maxNotesChars {
		m.Notes = m.Notes[:maxNotesChars]
	}
	if m.NotesURL != "" && !strings.HasPrefix(m.NotesURL, "https://") {
		return m, errors.New("the update file's notes_url is not an https address")
	}
	if len(m.Targets) == 0 {
		return m, errors.New("the update file names no downloads")
	}
	for key, t := range m.Targets {
		if !targetKeyRe.MatchString(key) {
			return m, fmt.Errorf("the update file names a download for %q, which is not a platform", key)
		}
		if err := t.check(); err != nil {
			return m, fmt.Errorf("%s: %v", key, err)
		}
	}
	return m, nil
}

func mustBase(s string) []int {
	b, _ := ParseBase(s)
	return b
}

func (t Target) check() error {
	if !assetNameRe.MatchString(t.Asset) {
		return fmt.Errorf("asset %q is not a file name", t.Asset)
	}
	if t.Size <= 0 || t.Size > maxAssetBytes {
		return fmt.Errorf("asset size %d is out of range", t.Size)
	}
	if !sha256Re.MatchString(t.SHA256) {
		return errors.New("asset sha256 is not 64 lowercase hex digits")
	}
	if t.Member == "" {
		if t.MemberSize != 0 || t.MemberSHA256 != "" {
			return errors.New("member_size and member_sha256 need a member")
		}
		if t.Size > maxMemberBytes && !strings.HasSuffix(strings.ToLower(t.Asset), ".appimage") {
			return fmt.Errorf("asset size %d is too large for a program file", t.Size)
		}
		return nil
	}
	clean := path.Clean(t.Member)
	if clean != t.Member || strings.HasPrefix(clean, "/") || strings.HasPrefix(clean, "../") || clean == ".." || strings.Contains(t.Member, "\\") {
		return fmt.Errorf("member %q is not a plain path inside the archive", t.Member)
	}
	if archiveKind(t.Asset) == "" {
		return fmt.Errorf("asset %q is not a .zip or .tar.gz, so it cannot hold a member", t.Asset)
	}
	if t.MemberSize <= 0 || t.MemberSize > maxMemberBytes {
		return fmt.Errorf("member size %d is out of range", t.MemberSize)
	}
	if !sha256Re.MatchString(t.MemberSHA256) {
		return errors.New("member sha256 is not 64 lowercase hex digits")
	}
	return nil
}

func archiveKind(name string) string {
	n := strings.ToLower(name)
	switch {
	case strings.HasSuffix(n, ".zip"):
		return "zip"
	case strings.HasSuffix(n, ".tar.gz"), strings.HasSuffix(n, ".tgz"):
		return "tgz"
	}
	return ""
}

// --- keys and signatures ----------------------------------------------------

//go:embed trusted-keys.txt
var trustedKeysFile string

// TrustedKeys are the public keys built into this program. Empty until the
// maintainer adds one (docs/UPDATES.md): a build without a key can still say
// a newer release exists, but installs nothing.
func TrustedKeys() []ed25519.PublicKey {
	keys, _ := ParseKeys(trustedKeysFile)
	return keys
}

const keyPrefix = "ed25519 "

// ParseKeys reads trusted-keys.txt: one "ed25519 <base64 public key>
// [comment]" per line; blank lines and # comments are skipped. A line that is
// not a key is an error, so a pasted key with a typo is noticed by the test
// suite rather than by every user's first update.
func ParseKeys(text string) ([]ed25519.PublicKey, error) {
	var out []ed25519.PublicKey
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 2 || fields[0] != "ed25519" {
			return out, fmt.Errorf("line %d: want \"ed25519 <base64 key>\"", i+1)
		}
		raw, err := base64.StdEncoding.DecodeString(fields[1])
		if err != nil || len(raw) != ed25519.PublicKeySize {
			return out, fmt.Errorf("line %d: not a %d-byte base64 ed25519 public key", i+1, ed25519.PublicKeySize)
		}
		out = append(out, ed25519.PublicKey(raw))
	}
	return out, nil
}

// KeyID is a short name for a key, for messages and the keys file comment.
func KeyID(pub ed25519.PublicKey) string {
	if len(pub) < 8 {
		return ""
	}
	return hex.EncodeToString(pub[:8])
}

// PublicKeyLine is pub as a trusted-keys.txt line.
func PublicKeyLine(pub ed25519.PublicKey, comment string) string {
	line := keyPrefix + base64.StdEncoding.EncodeToString(pub)
	if comment = strings.TrimSpace(comment); comment != "" {
		line += " " + comment
	}
	return line
}

// privateKeyHeader starts the private key file `gobbonet update keygen`
// writes. The rest of the line is the 32-byte seed in base64.
const privateKeyHeader = "gobbonet-update-private-key ed25519 "

// GenerateKey makes a signing key: the private key file's text, and the
// public key.
func GenerateKey() (privateFile string, pub ed25519.PublicKey, err error) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", nil, err
	}
	return privateKeyHeader + base64.StdEncoding.EncodeToString(priv.Seed()) + "\n", pub, nil
}

// ParsePrivateKey reads what GenerateKey wrote.
func ParsePrivateKey(text string) (ed25519.PrivateKey, error) {
	line := strings.TrimSpace(text)
	if !strings.HasPrefix(line, privateKeyHeader) {
		return nil, errors.New("not a GobboNet update signing key (made by `gobbonet update keygen`)")
	}
	seed, err := base64.StdEncoding.DecodeString(strings.TrimSpace(strings.TrimPrefix(line, privateKeyHeader)))
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, errors.New("the signing key file is damaged")
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// Sign makes the signature file's text for an update file's exact bytes.
func Sign(priv ed25519.PrivateKey, manifest []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, manifest)) + "\n"
}

// ErrNoTrustedKeys is Verify with no keys to verify against.
var ErrNoTrustedKeys = errors.New("this build has no update signing key, so it cannot check that a download came from the GobboNet maintainer")

// ErrBadSignature is a signature no trusted key made.
var ErrBadSignature = errors.New("the update file is not signed by a key this build trusts")

// Verify checks sig (the .sig file's text) against the update file's exact
// bytes, with each trusted key in turn.
func Verify(manifest, sig []byte, keys []ed25519.PublicKey) error {
	if len(keys) == 0 {
		return ErrNoTrustedKeys
	}
	if len(sig) > maxSignatureBytes {
		return ErrBadSignature
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil || len(raw) != ed25519.SignatureSize {
		return ErrBadSignature
	}
	for _, k := range keys {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, manifest, raw) {
			return nil
		}
	}
	return ErrBadSignature
}

// EncodeManifest writes an update file the way `gobbonet update manifest`
// does: indented, keys in a fixed order, so two runs over the same release
// produce the same bytes.
func EncodeManifest(m Manifest) ([]byte, error) {
	keys := make([]string, 0, len(m.Targets))
	for k := range m.Targets {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	// encoding/json already sorts map keys; the sort above is for the check
	// below, which wants a stable error.
	for _, k := range keys {
		if err := m.Targets[k].check(); err != nil {
			return nil, fmt.Errorf("%s: %v", k, err)
		}
	}
	out, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	out = append(out, '\n')
	if _, err := ParseManifest(out); err != nil {
		return nil, err
	}
	return out, nil
}
