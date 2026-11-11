package update_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/update"
	"github.com/ElodineOfficial/GobboNet/internal/update/updatetest"
)

// --- the rule: never backwards ----------------------------------------------

func TestParseBase(t *testing.T) {
	good := map[string][]int{
		"1.8.0": {1, 8, 0}, "v1.8.0": {1, 8, 0}, "1.7.6-Hotfix": {1, 7, 6},
		"1.8.0-go-abc1234": {1, 8, 0}, "2": {2}, "1.10.0": {1, 10, 0},
	}
	for in, want := range good {
		got, ok := update.ParseBase(in)
		if !ok || update.CompareBase(got, want) != 0 || len(got) != len(want) {
			t.Errorf("ParseBase(%q) = %v %v, want %v", in, got, ok, want)
		}
	}
	for _, bad := range []string{"", "dev", "v", "1..0", "1.8.x", "1.2.3.4.5", "-1.0", "1.8.0a", "9999999.0"} {
		if got, ok := update.ParseBase(bad); ok {
			t.Errorf("ParseBase(%q) = %v, want refused", bad, got)
		}
	}
	if update.CompareBase([]int{1, 10}, []int{1, 9, 9}) != 1 || update.CompareBase([]int{1, 8}, []int{1, 8, 0}) != 0 {
		t.Error("CompareBase does not order numerically, or treats a missing part as other than zero")
	}
}

func TestNewerNeverGoesBackwards(t *testing.T) {
	cur := update.Build{Version: "1.8.0", Build: "1.8.0-go-aaaaaaa", Serial: 1000}
	cases := []struct {
		name string
		cand update.Build
		want bool
	}{
		{"a later release", update.Build{"1.8.1", "1.8.1-go-bbbbbbb", 2000}, true},
		{"a later release built from an older commit", update.Build{"1.9.0", "1.9.0-go-bbbbbbb", 10}, true},
		{"a hotfix: same release, later commit", update.Build{"1.8.0", "1.8.0-go-ccccccc", 1001}, true},
		{"the same release from an earlier commit", update.Build{"1.8.0", "1.8.0-go-ddddddd", 999}, false},
		{"the same release, same commit time", update.Build{"1.8.0", "1.8.0-go-eeeeeee", 1000}, false},
		{"the build already running", update.Build{"1.8.0", "1.8.0-go-aaaaaaa", 5000}, false},
		{"an older release, however recent", update.Build{"1.7.9", "1.7.9-go-fffffff", 99999}, false},
		{"the same release with no serial", update.Build{"1.8.0", "1.8.0-go-ggggggg", 0}, false},
		{"not a release number", update.Build{"next", "next", 5000}, false},
	}
	for _, c := range cases {
		if got := update.Newer(cur, c.cand); got != c.want {
			t.Errorf("%s: Newer = %v, want %v", c.name, got, c.want)
		}
	}
	dev := update.Build{Version: "dev", Build: "dev"}
	if update.Newer(dev, update.Build{"9.9.9", "9.9.9-go-x", 1}) || dev.Updatable() {
		t.Error("an unstamped dev build must never be offered anything")
	}
}

// --- the update file and its signature ----------------------------------------

// The keys built into the program must parse: a pasted key with a typo would
// otherwise be found by every user's first update instead of by this test.
func TestTrustedKeysFileParses(t *testing.T) {
	raw, err := os.ReadFile("trusted-keys.txt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := update.ParseKeys(string(raw)); err != nil {
		t.Fatalf("internal/update/trusted-keys.txt: %v", err)
	}
	if !strings.Contains(string(raw), "gobbonet update keygen") {
		t.Error("the keys file should say how a key is made")
	}
}

func TestSignAndVerify(t *testing.T) {
	text, pub, err := update.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	priv, err := update.ParsePrivateKey(text)
	if err != nil {
		t.Fatal(err)
	}
	keys, err := update.ParseKeys("# a comment\n\n" + update.PublicKeyLine(pub, "test key") + "\n")
	if err != nil || len(keys) != 1 {
		t.Fatalf("ParseKeys: %v %v", keys, err)
	}
	m := []byte(`{"format":1}`)
	sig := update.Sign(priv, m)
	if err := update.Verify(m, []byte(sig), keys); err != nil {
		t.Fatalf("a good signature: %v", err)
	}
	if err := update.Verify([]byte(`{"format":2}`), []byte(sig), keys); !errors.Is(err, update.ErrBadSignature) {
		t.Errorf("a changed file: %v, want ErrBadSignature", err)
	}
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	if err := update.Verify(m, []byte(sig), []ed25519.PublicKey{otherPub}); !errors.Is(err, update.ErrBadSignature) {
		t.Errorf("another key: %v, want ErrBadSignature", err)
	}
	if err := update.Verify(m, []byte(sig), nil); !errors.Is(err, update.ErrNoTrustedKeys) {
		t.Errorf("no keys: %v, want ErrNoTrustedKeys", err)
	}
	if err := update.Verify(m, []byte("garbage"), keys); !errors.Is(err, update.ErrBadSignature) {
		t.Errorf("garbage: %v", err)
	}
	if _, err := update.ParseKeys("ed25519 notbase64!!\n"); err == nil {
		t.Error("a malformed key line was accepted")
	}
	if _, err := update.ParsePrivateKey("ed25519 " + strings.Repeat("A", 44)); err == nil {
		t.Error("something that is not a key file was accepted as one")
	}
}

func goodManifest() update.Manifest {
	return *updatetest.Manifest("1.8.1-go-bbbbbbb", 2000, "linux-amd64", update.Target{
		Asset: "GobboNet-1_8_1-update.zip", Size: 10, SHA256: strings.Repeat("a", 64),
		Member: "GobboNet/linux-amd64/gobbonet", MemberSize: 5, MemberSHA256: strings.Repeat("b", 64)})
}

func TestParseManifestRefusesMistakes(t *testing.T) {
	raw, err := update.EncodeManifest(goodManifest())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := update.ParseManifest(raw); err != nil {
		t.Fatalf("a good manifest: %v", err)
	}
	bad := map[string]func(*update.Manifest){
		"another product":            func(m *update.Manifest) { m.Product = "other" },
		"another format":             func(m *update.Manifest) { m.Format = 2 },
		"a build of another release": func(m *update.Manifest) { m.Build = "1.9.0-go-x" },
		"no serial":                  func(m *update.Manifest) { m.Serial = 0 },
		"a member outside the archive": func(m *update.Manifest) {
			t := m.Targets["linux-amd64"]
			t.Member = "../../evil"
			m.Targets["linux-amd64"] = t
		},
		"an absolute member": func(m *update.Manifest) {
			t := m.Targets["linux-amd64"]
			t.Member = "/usr/bin/x"
			m.Targets["linux-amd64"] = t
		},
		"a sha256 that is not one": func(m *update.Manifest) {
			t := m.Targets["linux-amd64"]
			t.SHA256 = "abc"
			m.Targets["linux-amd64"] = t
		},
		"an asset name with a path": func(m *update.Manifest) {
			t := m.Targets["linux-amd64"]
			t.Asset = "../x.zip"
			m.Targets["linux-amd64"] = t
		},
		"plain-http notes": func(m *update.Manifest) { m.NotesURL = "http://example.com" },
	}
	for name, mutate := range bad {
		m := goodManifest()
		m.Targets = map[string]update.Target{"linux-amd64": m.Targets["linux-amd64"]}
		mutate(&m)
		raw, _ := jsonOf(m)
		if _, err := update.ParseManifest(raw); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := update.ParseManifest([]byte(`{"format":1,"product":"gobbonet","surprise":true}`)); err == nil {
		t.Error("an unknown field was accepted")
	}
}

// --- checking ----------------------------------------------------------------

var cur180 = update.Build{Version: "1.8.0", Build: "1.8.0-go-aaaaaaa", Serial: 1000}

func release(tag, build string, serial int64) updatetest.Release {
	prog := []byte("program " + build)
	z := updatetest.Zip(map[string][]byte{"GobboNet/linux-amd64/gobbonet": prog})
	name := "GobboNet-" + tag + "-update.zip"
	return updatetest.Release{Tag: tag,
		Manifest: updatetest.Manifest(build, serial, "linux-amd64", updatetest.ZipTarget(name, z, "GobboNet/linux-amd64/gobbonet", prog)),
		Assets:   map[string][]byte{name: z}}
}

func TestCheckPicksTheBestSignedNewerRelease(t *testing.T) {
	other := func() ed25519.PrivateKey { _, k, _ := ed25519.GenerateKey(rand.Reader); return k }()
	unsigned := release("v9.9.9", "9.9.9-go-zzzzzzz", 9000)
	unsigned.SignWith = other
	pre := release("v2.0.0", "2.0.0-go-yyyyyyy", 8000)
	pre.Prerelease = true
	srv := updatetest.New(t,
		release("v1.7.9-late", "1.7.9-go-ooooooo", 99999), // an older release, published later
		unsigned,
		pre,
		release("v1.8.1", "1.8.1-go-bbbbbbb", 2000),
		release("1.8.0-Hotfix", "1.8.0-go-ccccccc", 1500),
	)
	res, err := srv.Checker().Check(context.Background(), cur180, "linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if res.Offer == nil || res.Offer.Manifest.Build != "1.8.1-go-bbbbbbb" {
		t.Fatalf("offer = %+v, want 1.8.1", res.Offer)
	}
	if res.Offer.TargetKey != "linux-amd64" || res.Offer.Asset.URL == "" {
		t.Errorf("the offer has no download for this platform: %+v", res.Offer)
	}
	if !strings.Contains(strings.Join(res.Notes, "\n"), "v9.9.9") {
		t.Errorf("a release signed by another key should be noted as skipped: %v", res.Notes)
	}
	if srv.Hits("/download/v2.0.0/"+update.ManifestName) != 0 {
		t.Error("a prerelease's update file was read")
	}
}

func TestCheckOffersAHotfixOfTheSameRelease(t *testing.T) {
	srv := updatetest.New(t, release("1.8.0-Hotfix", "1.8.0-go-ccccccc", 1500), release("v1.8.0", "1.8.0-go-aaaaaaa", 1000))
	res, err := srv.Checker().Check(context.Background(), cur180, "linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if res.Offer == nil || res.Offer.Manifest.Build != "1.8.0-go-ccccccc" {
		t.Fatalf("offer = %+v, want the hotfix", res.Offer)
	}
	if !update.Hotfix(cur180, res.Offer.Manifest.Of()) {
		t.Error("a later build of 1.8.0 should be reported as a fix for it")
	}

	// Running the hotfix, the original 1.8.0 is never offered back.
	fixed := update.Build{Version: "1.8.0", Build: "1.8.0-go-ccccccc", Serial: 1500}
	res, err = srv.Checker().Check(context.Background(), fixed, "linux-amd64")
	if err != nil || res.Offer != nil {
		t.Fatalf("on the hotfix: offer = %+v, err = %v; want none", res.Offer, err)
	}
}

func TestCheckWithoutAKeyInstallsNothing(t *testing.T) {
	srv := updatetest.New(t, release("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	c := srv.Checker()
	c.Keys = nil
	res, err := c.Check(context.Background(), cur180, "linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if res.Offer != nil {
		t.Error("a build with no trusted key made an offer")
	}
	if res.NewestTag != "v1.8.1" {
		t.Errorf("newest = %q, want the newest tag to point at", res.NewestTag)
	}
	if srv.Hits("/download/v1.8.1/"+update.ManifestName) != 0 {
		t.Error("nothing should be downloaded when nothing can be checked")
	}
}

func TestCheckReportsAReleaseWithNothingForThisPlatform(t *testing.T) {
	srv := updatetest.New(t, release("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	res, err := srv.Checker().Check(context.Background(), cur180, "windows-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if res.Offer == nil || res.Offer.TargetKey != "" {
		t.Fatalf("offer = %+v; want 1.8.1 with no download for windows", res.Offer)
	}
}

func TestCheckRefusesASizeTheListDisagreesWith(t *testing.T) {
	r := release("v1.8.1", "1.8.1-go-bbbbbbb", 2000)
	r.SizeOverride = map[string]int64{"GobboNet-v1.8.1-update.zip": 5}
	srv := updatetest.New(t, r)
	res, err := srv.Checker().Check(context.Background(), cur180, "linux-amd64")
	if err != nil {
		t.Fatal(err)
	}
	if res.Offer == nil || res.Offer.TargetKey != "" {
		t.Fatalf("an asset whose size disagrees with the signed file must not be installable: %+v", res.Offer)
	}
}

func TestCheckErrors(t *testing.T) {
	srv := updatetest.New(t)
	srv.Status = http.StatusForbidden
	if _, err := srv.Checker().Check(context.Background(), cur180, "linux-amd64"); err == nil || !strings.Contains(err.Error(), "limiting") {
		t.Errorf("rate limited: %v", err)
	}
	if _, err := (&update.Checker{}).Check(context.Background(), cur180, "linux-amd64"); !errors.Is(err, update.ErrOff) {
		t.Errorf("no URL: %v, want ErrOff", err)
	}
}

// Every request, and every redirect, stays on GitHub or the list's own host.
func TestRequestsStayOnAllowedHosts(t *testing.T) {
	evil := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("[]")) }))
	defer evil.Close()
	evilURL := strings.Replace(evil.URL, "127.0.0.1", "localhost", 1)
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://evil.example/releases", http.StatusFound)
	}))
	defer redirector.Close()
	c := &update.Checker{ReleasesURL: redirector.URL + "/releases", Keys: []ed25519.PublicKey{make([]byte, 32)},
		Client: update.GuardClient(redirector.Client(), redirector.URL+"/releases")}
	if _, err := c.Check(context.Background(), cur180, "linux-amd64"); err == nil || !strings.Contains(err.Error(), "evil.example") {
		t.Errorf("a redirect off the allowed hosts: %v", err)
	}
	if _, err := update.NewClient("http://example.com/releases"); err == nil {
		t.Error("a plain-http release list off this machine was accepted")
	}
	if _, err := update.NewClient("https://example.com/releases"); err != nil {
		t.Errorf("an https mirror should be accepted as the list's own host: %v", err)
	}
	// A download named by a list on one host, from another host, is refused.
	client := update.GuardClient(evil.Client(), "http://127.0.0.1:1/releases")
	if _, err := client.Get(evilURL + "/x"); err == nil {
		t.Error("a request to a host that is neither GitHub nor the list's was let through")
	}
}

// --- installing ----------------------------------------------------------------

func installFixture(t *testing.T, build string, serial int64) (*updatetest.Server, string, *update.Offer, []byte) {
	t.Helper()
	srv := updatetest.New(t, release("v1.8.1", build, serial))
	res, err := srv.Checker().Check(context.Background(), cur180, "linux-amd64")
	if err != nil || res.Offer == nil || res.Offer.TargetKey == "" {
		t.Fatalf("no offer: %+v %v", res, err)
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "gobbonet")
	if err := os.WriteFile(exe, []byte("old program"), 0o755); err != nil {
		t.Fatal(err)
	}
	return srv, exe, res.Offer, []byte("program " + build)
}

func stampSays(build string, serial int64) func(context.Context, string) (update.Stamp, error) {
	return func(context.Context, string) (update.Stamp, error) {
		return update.Stamp{Build: build, Serial: serial, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}, nil
	}
}

func place(exe string) update.Place {
	return update.Place{Kind: update.KindFile, Path: exe, Target: "linux-amd64"}
}

func TestInstallReplacesTheProgram(t *testing.T) {
	srv, exe, offer, prog := installFixture(t, "1.8.1-go-bbbbbbb", 2000)
	var stages []string
	in := &update.Installer{Client: srv.GuardedClient(), WorkDir: t.TempDir(),
		Smoke:    stampSays("1.8.1-go-bbbbbbb", 2000),
		Progress: func(stage string, done, total int64) { stages = append(stages, stage) }}
	got, err := in.Install(context.Background(), offer, place(exe))
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); !bytes.Equal(b, prog) {
		t.Errorf("the program is %q, want the new one", b)
	}
	if b, _ := os.ReadFile(got.Old); string(b) != "old program" {
		t.Errorf("the old program should be kept beside it until the next start, at %s", got.Old)
	}
	if fi, _ := os.Stat(exe); runtime.GOOS != "windows" && fi.Mode().Perm()&0o100 == 0 {
		t.Error("the new program is not executable")
	}
	if strings.Join(stages, ",") == "" || !strings.Contains(strings.Join(stages, ","), update.StageInstalling) {
		t.Errorf("progress stages: %v", stages)
	}
	removed, left := update.CleanupOld(exe)
	if len(removed) != 1 || len(left) != 0 {
		t.Errorf("CleanupOld removed %v, left %v", removed, left)
	}
	if _, err := os.Stat(got.Old); !errors.Is(err, os.ErrNotExist) {
		t.Error("the old program is still there after the clean-up")
	}
}

func TestInstallKeepsTheOldProgramWhenACheckFails(t *testing.T) {
	cases := map[string]func(*update.Offer, *update.Installer){
		"the download does not match its SHA-256": func(o *update.Offer, in *update.Installer) { o.Target.SHA256 = strings.Repeat("0", 64) },
		"the program does not match its SHA-256": func(o *update.Offer, in *update.Installer) {
			o.Target.MemberSHA256 = strings.Repeat("0", 64)
		},
		"the new program reports another build": func(o *update.Offer, in *update.Installer) {
			in.Smoke = stampSays("1.8.1-go-somethingelse", 2000)
		},
		"the new program reports another serial": func(o *update.Offer, in *update.Installer) {
			in.Smoke = stampSays("1.8.1-go-bbbbbbb", 1)
		},
		"the new program will not start": func(o *update.Offer, in *update.Installer) {
			in.Smoke = func(context.Context, string) (update.Stamp, error) {
				return update.Stamp{}, errors.New("exec format error")
			}
		},
		"the archive lacks the program": func(o *update.Offer, in *update.Installer) { o.Target.Member = "GobboNet/elsewhere" },
	}
	for name, mutate := range cases {
		srv, exe, offer, _ := installFixture(t, "1.8.1-go-bbbbbbb", 2000)
		o := *offer
		in := &update.Installer{Client: srv.GuardedClient(), WorkDir: t.TempDir(), Smoke: stampSays("1.8.1-go-bbbbbbb", 2000)}
		mutate(&o, in)
		if _, err := in.Install(context.Background(), &o, place(exe)); err == nil {
			t.Errorf("%s: installed anyway", name)
			continue
		}
		if b, _ := os.ReadFile(exe); string(b) != "old program" {
			t.Errorf("%s: the old program was replaced", name)
		}
		entries, _ := os.ReadDir(filepath.Dir(exe))
		if len(entries) != 1 {
			var names []string
			for _, e := range entries {
				names = append(names, e.Name())
			}
			t.Errorf("%s: left behind %v", name, names)
		}
	}
}

func TestInstallRefusesAnInstallItCannotDo(t *testing.T) {
	srv, exe, offer, _ := installFixture(t, "1.8.1-go-bbbbbbb", 2000)
	in := &update.Installer{Client: srv.GuardedClient(), WorkDir: t.TempDir(), Smoke: stampSays("1.8.1-go-bbbbbbb", 2000)}
	pkg := update.Place{Kind: update.KindPackage, Path: exe, Target: "linux-amd64", Reason: "installed by a package"}
	if _, err := in.Install(context.Background(), offer, pkg); err == nil {
		t.Error("a package-managed program was replaced")
	}
	win := update.Place{Kind: update.KindFile, Path: exe, Target: "windows-amd64"}
	if _, err := in.Install(context.Background(), offer, win); err == nil {
		t.Error("a linux download was installed over a windows program")
	}
}

func TestInstallFromATarGz(t *testing.T) {
	prog := []byte("program 1.8.1-go-bbbbbbb")
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "./gobbonet-1.8.1/README.md", Mode: 0o644, Size: 2, Typeflag: tar.TypeReg})
	tw.Write([]byte("hi"))
	tw.WriteHeader(&tar.Header{Name: "./gobbonet-1.8.1/gobbonet", Mode: 0o755, Size: int64(len(prog)), Typeflag: tar.TypeReg})
	tw.Write(prog)
	tw.Close()
	gz.Close()
	tgz := buf.Bytes()
	tgt := update.Target{Asset: "gobbonet-1.8.1-linux-amd64.tar.gz", Size: int64(len(tgz)), SHA256: updatetest.Sum(tgz),
		Member: "gobbonet-1.8.1/gobbonet", MemberSize: int64(len(prog)), MemberSHA256: updatetest.Sum(prog)}
	srv := updatetest.New(t, updatetest.Release{Tag: "v1.8.1",
		Manifest: updatetest.Manifest("1.8.1-go-bbbbbbb", 2000, "linux-amd64", tgt),
		Assets:   map[string][]byte{tgt.Asset: tgz}})
	res, err := srv.Checker().Check(context.Background(), cur180, "linux-amd64")
	if err != nil || res.Offer == nil {
		t.Fatal(res, err)
	}
	exe := filepath.Join(t.TempDir(), "gobbonet")
	os.WriteFile(exe, []byte("old program"), 0o755)
	in := &update.Installer{Client: srv.GuardedClient(), WorkDir: t.TempDir(), Smoke: stampSays("1.8.1-go-bbbbbbb", 2000)}
	if _, err := in.Install(context.Background(), res.Offer, place(exe)); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); !bytes.Equal(b, prog) {
		t.Errorf("program = %q", b)
	}
}

func TestPlace(t *testing.T) {
	yes := func(string) bool { return true }
	no := func(string) bool { return false }
	cases := []struct {
		name                   string
		goos, exe, img, appdir string
		writable               func(string) bool
		kind, target           string
	}{
		{"the Windows ZIP or installer", "windows", `C:\Users\me\AppData\Local\GobboNet\gobbonet.exe`, "", "", yes, update.KindFile, "windows-amd64"},
		{"a folder that cannot be written", "windows", `C:\Program Files\GobboNet\gobbonet.exe`, "", "", no, update.KindReadOnly, "windows-amd64"},
		{"the Linux ZIP", "linux", "/home/me/GobboNet/linux-amd64/gobbonet", "", "", yes, update.KindFile, "linux-amd64"},
		{"a .deb or .rpm", "linux", "/usr/lib/gobbonet/gobbonet", "", "", yes, update.KindPackage, "linux-amd64"},
		{"an AppImage", "linux", "/tmp/.mount_GobboX/usr/lib/gobbonet/gobbonet", "/home/me/Apps/GobboNet.AppImage", "/tmp/.mount_GobboX", yes, update.KindAppImage, "appimage-amd64"},
		{"another AppImage's variables", "linux", "/home/me/GobboNet/linux-amd64/gobbonet", "/home/me/Apps/Terminal.AppImage", "/tmp/.mount_Term", yes, update.KindFile, "linux-amd64"},
	}
	for _, c := range cases {
		p := update.LocateFor(c.goos, "amd64", c.exe, c.img, c.appdir, c.writable)
		if p.Kind != c.kind || p.Target != c.target {
			t.Errorf("%s: %s/%s, want %s/%s", c.name, p.Kind, p.Target, c.kind, c.target)
		}
		if (p.Kind == update.KindFile || p.Kind == update.KindAppImage) != p.CanInstall() {
			t.Errorf("%s: CanInstall = %v", c.name, p.CanInstall())
		}
		if !p.CanInstall() && p.Reason == "" {
			t.Errorf("%s: no reason given", c.name)
		}
	}
	if p := update.LocateFor("linux", "amd64", "/tmp/.mount_X/usr/lib/gobbonet/gobbonet", "/home/me/G.AppImage", "/tmp/.mount_X", yes); p.Path != "/home/me/G.AppImage" {
		t.Errorf("an AppImage update replaces the .AppImage file, not %s", p.Path)
	}
}

func TestDownloadStalls(t *testing.T) {
	restore := update.SetStallTimeout(200 * time.Millisecond)
	defer restore()
	block := make(chan struct{})
	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.Write([]byte("x"))
		w.(http.Flusher).Flush()
		<-block
	}))
	defer slow.Close()
	defer close(block)
	exe := filepath.Join(t.TempDir(), "gobbonet")
	os.WriteFile(exe, []byte("old program"), 0o755)
	o := &update.Offer{TargetKey: "linux-amd64", Manifest: goodManifest(),
		Target: update.Target{Asset: "x", Size: 100, SHA256: strings.Repeat("a", 64)},
		Asset:  update.Asset{Name: "x", URL: slow.URL + "/x", Size: 100}}
	in := &update.Installer{Client: update.GuardClient(slow.Client(), slow.URL), WorkDir: t.TempDir()}
	_, err := in.Install(context.Background(), o, place(exe))
	if err == nil || !strings.Contains(err.Error(), "stalled") {
		t.Errorf("err = %v, want a stall", err)
	}
}

func TestNewPathKeepsExeLast(t *testing.T) {
	if got := update.NewPathFor(filepath.Join("dir", "gobbonet.exe")); got != filepath.Join("dir", "gobbonet.new.exe") {
		t.Errorf("windows: %s", got)
	}
	if got := update.NewPathFor(filepath.Join("dir", "gobbonet")); got != filepath.Join("dir", "gobbonet.new") {
		t.Errorf("linux: %s", got)
	}
	dir := t.TempDir()
	exe := filepath.Join(dir, "gobbonet.exe")
	for _, n := range []string{"gobbonet.exe", "gobbonet.new.exe", "gobbonet.exe.old", "gobbonet.exe.old-123", "gobbonet.exe.keep"} {
		os.WriteFile(filepath.Join(dir, n), []byte("x"), 0o644)
	}
	removed, left := update.CleanupOld(exe)
	if len(removed) != 3 || len(left) != 0 {
		t.Errorf("CleanupOld removed %v, left %v", removed, left)
	}
	if _, err := os.Stat(exe); err != nil {
		t.Error("CleanupOld removed the program itself")
	}
	if _, err := os.Stat(filepath.Join(dir, "gobbonet.exe.keep")); err != nil {
		t.Error("CleanupOld removed a file that is not its own")
	}
}

func TestSwapPutsTheOldProgramBack(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gobbonet")
	os.WriteFile(exe, []byte("old program"), 0o755)
	if _, err := update.Swap(exe, filepath.Join(dir, "missing.new")); err == nil {
		t.Fatal("a swap with nothing to put in place succeeded")
	}
	if b, _ := os.ReadFile(exe); string(b) != "old program" {
		t.Error("the old program was not moved back")
	}
}

func jsonOf(m update.Manifest) ([]byte, error) { return json.Marshal(m) }
