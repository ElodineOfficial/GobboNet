package update

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/version"
)

// stampRe finds version.Stamp's value in a program file. Strict, so that the
// prefix appearing anywhere else in the file -- this code has it -- cannot
// pass for a stamp.
var stampRe = regexp.MustCompile(regexp.QuoteMeta(version.StampPrefix) + `([0-9]{1,6}(?:\.[0-9]{1,6}){0,3}-go-[0-9A-Za-z.-]{1,40})/([0-9]{1,12})\]`)

// ReadStampFile reads the stamp a GobboNet program file was built with,
// without running it, so that a Windows program can be described on Linux.
// The build and serial come from version.Stamp's value, which the build
// scripts put in the file; the platform from the build information the Go
// toolchain records.
func ReadStampFile(file string) (Stamp, error) {
	info, err := buildinfo.ReadFile(file)
	if err != nil {
		return Stamp{}, fmt.Errorf("%s is not a Go program: %v", file, err)
	}
	var s Stamp
	for _, kv := range info.Settings {
		switch kv.Key {
		case "GOOS":
			s.GOOS = kv.Value
		case "GOARCH":
			s.GOARCH = kv.Value
		}
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return s, err
	}
	found := map[string]bool{}
	for _, m := range stampRe.FindAllSubmatch(raw, 4) {
		found[string(m[0])] = true
		s.Build = string(m[1])
		s.Serial, _ = strconv.ParseInt(string(m[2]), 10, 64)
	}
	switch {
	case len(found) == 0:
		return s, fmt.Errorf("%s has no build stamp: build it with scripts/make-zip.sh from a git checkout", file)
	case len(found) > 1:
		return s, fmt.Errorf("%s carries more than one build stamp", file)
	}
	s.Version = s.Build
	if i := strings.Index(s.Build, "-go-"); i > 0 {
		s.Version = s.Build[:i]
	}
	return s, nil
}

// TargetInput is one platform for BuildManifest: the file to attach to the
// release, and the program's path inside it when it is an archive.
type TargetInput struct {
	Key    string
	Asset  string
	Member string
}

// ManifestInput is what `gobbonet update manifest` is given.
type ManifestInput struct {
	Targets   []TargetInput
	Notes     string
	NotesURL  string
	Published time.Time
	// RunAppImage reads an AppImage's stamp by running it; nil uses RunStamp
	// with APPIMAGE_EXTRACT_AND_RUN=1, so no FUSE is needed.
	RunAppImage func(ctx context.Context, file string) (Stamp, error)
}

// BuildManifest describes a release's downloads. Every program in it must
// carry the same stamp, and that stamp becomes the update file's version,
// build and serial -- read out of the files themselves, so the update file
// cannot describe a different build than the one it points at.
func BuildManifest(in ManifestInput) (Manifest, error) {
	m := Manifest{Format: ManifestFormat, Product: Product, Notes: strings.TrimSpace(in.Notes), NotesURL: in.NotesURL,
		Targets: map[string]Target{}}
	if !in.Published.IsZero() {
		m.Published = in.Published.UTC().Format(time.RFC3339)
	}
	if len(in.Targets) == 0 {
		return m, errors.New("no downloads given")
	}
	sort.Slice(in.Targets, func(i, j int) bool { return in.Targets[i].Key < in.Targets[j].Key })
	var first *Stamp
	for _, ti := range in.Targets {
		if !targetKeyRe.MatchString(ti.Key) {
			return m, fmt.Errorf("%q is not a platform such as windows-amd64", ti.Key)
		}
		if _, dup := m.Targets[ti.Key]; dup {
			return m, fmt.Errorf("%s is given twice", ti.Key)
		}
		t, stamp, err := describe(ti, in.RunAppImage)
		if err != nil {
			return m, fmt.Errorf("%s: %v", ti.Key, err)
		}
		goos, goarch := targetPlatform(ti.Key)
		if stamp.GOOS != goos || stamp.GOARCH != goarch {
			return m, fmt.Errorf("%s: the program in %s is for %s/%s", ti.Key, filepath.Base(ti.Asset), stamp.GOOS, stamp.GOARCH)
		}
		if first == nil {
			s := stamp
			first = &s
		} else if stamp.Build != first.Build || stamp.Serial != first.Serial {
			return m, fmt.Errorf("%s is build %s (serial %d) but the others are %s (serial %d): build every download from one commit",
				ti.Key, stamp.Build, stamp.Serial, first.Build, first.Serial)
		}
		m.Targets[ti.Key] = t
	}
	if first.Build == "dev" || first.Serial <= 0 {
		return m, fmt.Errorf("the programs are stamped %q with serial %d: build them with scripts/make-zip.sh from a commit", first.Build, first.Serial)
	}
	m.Version, m.Build, m.Serial = first.Version, first.Build, first.Serial
	if _, err := EncodeManifest(m); err != nil {
		return m, err
	}
	return m, nil
}

// targetPlatform is the GOOS/GOARCH a platform key's program is built for.
func targetPlatform(key string) (string, string) {
	goos, goarch, _ := strings.Cut(key, "-")
	if goos == "appimage" {
		goos = "linux"
	}
	return goos, goarch
}

// githubKeepsName matches the file names GitHub attaches to a release as
// they are. It renames others: a "+" is dropped, so 1.7.9's packages, built
// as gobbonet_1.7.9+go... and GobboNet-1.7.9+go..., are listed as
// gobbonet_1.7.9go... and GobboNet-1.7.9go.... The update file names each
// download as the release lists it, and a check that finds no file of that
// name offers nothing, so a name GitHub would change is refused here.
var githubKeepsName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func describe(ti TargetInput, runAppImage func(context.Context, string) (Stamp, error)) (Target, Stamp, error) {
	t := Target{Asset: filepath.Base(ti.Asset), Member: ti.Member}
	if !githubKeepsName.MatchString(t.Asset) {
		return t, Stamp{}, fmt.Errorf("GitHub would rename %s when it is attached (it drops a \"+\"), and the update file has to name it as the release lists it: rename it %s, and attach it under that name",
			t.Asset, strings.ReplaceAll(t.Asset, "+", ""))
	}
	size, sum, err := hashFile(ti.Asset)
	if err != nil {
		return t, Stamp{}, err
	}
	t.Size, t.SHA256 = size, sum
	if ti.Member == "" {
		if !strings.HasPrefix(ti.Key, "appimage-") {
			return t, Stamp{}, errors.New("only an AppImage is attached as the program itself; give the archive's member for the others")
		}
		run := runAppImage
		if run == nil {
			run = func(ctx context.Context, file string) (Stamp, error) {
				return runStamp(ctx, file, []string{"APPIMAGE_EXTRACT_AND_RUN=1"})
			}
		}
		os.Chmod(ti.Asset, 0o755)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
		defer cancel()
		stamp, err := run(ctx, ti.Asset)
		if err != nil {
			return t, stamp, fmt.Errorf("could not run %s to read its version: %v", t.Asset, err)
		}
		return t, stamp, nil
	}
	kind := archiveKind(t.Asset)
	if kind == "" {
		return t, Stamp{}, fmt.Errorf("%s is not a .zip or .tar.gz", t.Asset)
	}
	msize, err := memberSize(ti.Asset, kind, ti.Member)
	if err != nil {
		return t, Stamp{}, err
	}
	tmp, err := os.CreateTemp("", "gobbonet-update-member-*")
	if err != nil {
		return t, Stamp{}, err
	}
	tmp.Close()
	defer os.Remove(tmp.Name())
	msum, err := extract(ti.Asset, kind, ti.Member, msize, tmp.Name())
	if err != nil {
		return t, Stamp{}, err
	}
	t.MemberSize, t.MemberSHA256 = msize, msum
	stamp, err := ReadStampFile(tmp.Name())
	if err != nil {
		return t, stamp, fmt.Errorf("%s in %s: %v", ti.Member, t.Asset, err)
	}
	return t, stamp, nil
}

func hashFile(file string) (int64, string, error) {
	f, err := os.Open(file)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return 0, "", err
	}
	return n, hex.EncodeToString(h.Sum(nil)), nil
}

// memberSize finds a member in an archive and returns its size.
func memberSize(src, kind, member string) (int64, error) {
	switch kind {
	case "zip":
		zr, err := zip.OpenReader(src)
		if err != nil {
			return 0, err
		}
		defer zr.Close()
		for _, f := range zr.File {
			if f.Name == member {
				return int64(f.UncompressedSize64), nil
			}
		}
	case "tgz":
		f, err := os.Open(src)
		if err != nil {
			return 0, err
		}
		defer f.Close()
		gz, err := gzip.NewReader(f)
		if err != nil {
			return 0, err
		}
		defer gz.Close()
		tr := tar.NewReader(gz)
		for {
			hdr, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return 0, err
			}
			if path.Clean(strings.TrimPrefix(hdr.Name, "./")) == member {
				return hdr.Size, nil
			}
		}
	}
	return 0, fmt.Errorf("%s has no %s in it", filepath.Base(src), member)
}
