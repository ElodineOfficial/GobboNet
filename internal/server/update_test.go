package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/update"
	"github.com/ElodineOfficial/GobboNet/internal/update/updatetest"
)

// The update button (1.8.0): who may check, install and restart, and the
// rule that nothing older is ever installed. The releases come from a fake
// GitHub on this machine (internal/update/updatetest), signed with a key made
// for the test.

var running180 = update.Build{Version: "1.8.0", Build: "1.8.0-go-aaaaaaa", Serial: 1000}

func fakeRelease(tag, build string, serial int64) updatetest.Release {
	prog := []byte("program " + build)
	z := updatetest.Zip(map[string][]byte{"GobboNet/linux-amd64/gobbonet": prog})
	name := "GobboNet-" + tag + "-update.zip"
	return updatetest.Release{Tag: tag,
		Manifest: updatetest.Manifest(build, serial, "linux-amd64", updatetest.ZipTarget(name, z, "GobboNet/linux-amd64/gobbonet", prog)),
		Assets:   map[string][]byte{name: z}}
}

// updateServer is a Server whose update button asks gh and installs over a
// program file in a temporary folder.
func updateServer(t *testing.T, gh *updatetest.Server) (*Server, string) {
	t.Helper()
	s, cfg := newTestServer(t)
	s.cfg.UpdateReleasesURL = gh.ReleasesURL()
	exe := filepath.Join(t.TempDir(), "gobbonet")
	if err := os.WriteFile(exe, []byte("old program"), 0o755); err != nil {
		t.Fatal(err)
	}
	s.upd.place = update.Place{Kind: update.KindFile, Path: exe, Target: "linux-amd64"}
	s.upd.current = func() update.Build { return running180 }
	s.upd.newChecker = gh.Checker
	s.upd.newInstaller = func() *update.Installer {
		return &update.Installer{Client: gh.GuardedClient(), WorkDir: filepath.Join(cfg.DataDir, "update"),
			Smoke: func(_ context.Context, path string) (update.Stamp, error) {
				// The program the fake release carries says which build it is.
				b, err := os.ReadFile(path)
				if err != nil {
					return update.Stamp{}, err
				}
				build := strings.TrimPrefix(string(b), "program ")
				serial := int64(0)
				if build == "1.8.1-go-bbbbbbb" {
					serial = 2000
				}
				return update.Stamp{Build: build, Serial: serial, GOOS: runtime.GOOS, GOARCH: runtime.GOARCH}, nil
			}}
	}
	return s, exe
}

func checkBody(t *testing.T, s *Server, req cfReq) map[string]any {
	t.Helper()
	w := req.do(s)
	if w.Code != 200 {
		t.Fatalf("%s %s: %d %s", req.method, req.path, w.Code, w.Body)
	}
	var out map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestUpdateCheckOffersANewerRelease(t *testing.T) {
	gh := updatetest.New(t, fakeRelease("v1.7.9", "1.7.9-go-ooooooo", 99999), fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	s, _ := updateServer(t, gh)
	body := checkBody(t, s, fromPC("GET", "/update/check", ""))
	if body["status"] != "available" {
		t.Fatalf("status = %v, want available: %v", body["status"], body)
	}
	offer, _ := body["offer"].(map[string]any)
	if offer["build"] != "1.8.1-go-bbbbbbb" || offer["installable"] != true || offer["hotfix"] != false {
		t.Errorf("offer = %v", offer)
	}
	if offer["size"] == nil {
		t.Error("the offer does not say how big the download is")
	}

	// A phone may check, and is told where to install.
	body = checkBody(t, s, fromPhone("GET", "/update/check", ""))
	if body["status"] != "available" || body["on_this_pc"] != false {
		t.Errorf("from a phone: status %v, on_this_pc %v", body["status"], body["on_this_pc"])
	}
	// The second check came from the cache, not GitHub.
	if n := gh.Hits("/releases"); n != 1 {
		t.Errorf("the release list was asked %d times for two presses within a minute", n)
	}
}

func TestUpdateCheckStates(t *testing.T) {
	gh := updatetest.New(t, fakeRelease("v1.7.9", "1.7.9-go-ooooooo", 99999))
	s, _ := updateServer(t, gh)
	if got := checkBody(t, s, fromPC("GET", "/update/check", ""))["status"]; got != "current" {
		t.Errorf("only an older release on GitHub: status %v, want current", got)
	}

	// A build made without the signing key finds the release but cannot
	// check it, so it points at the release page instead of offering it.
	s.upd.newChecker = func() *update.Checker { c := gh.Checker(); c.Keys = nil; return c }
	s.upd.lastAt = time.Time{}
	gh.SetReleases(fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	body := checkBody(t, s, fromPC("GET", "/update/check", ""))
	if body["status"] != "unverifiable" || body["signing_key"] != false || body["offer"] != nil {
		t.Errorf("no signing key: status %v, signing_key %v, offer %v", body["status"], body["signing_key"], body["offer"])
	}
	if newest, _ := body["newest"].(map[string]any); newest["tag"] != "v1.8.1" {
		t.Errorf("no signing key: newest = %v, want the release to point at", body["newest"])
	}
	if w := fromPC("POST", "/update/install", `{"build":"1.8.1-go-bbbbbbb","serial":2000}`).do(s); w.Code != 409 {
		t.Errorf("install with no signing key: %d, want 409", w.Code)
	}

	s.upd.current = func() update.Build { return update.Build{Version: "dev", Build: "dev"} }
	hits := gh.Hits("/releases")
	if got := checkBody(t, s, fromPC("GET", "/update/check", ""))["status"]; got != "dev" {
		t.Errorf("a dev build: status %v", got)
	}
	if gh.Hits("/releases") != hits {
		t.Error("a dev build asked GitHub anyway")
	}

	s.cfg.UpdateReleasesURL = ""
	if got := checkBody(t, s, fromPC("GET", "/update/check", ""))["status"]; got != "off" {
		t.Errorf("update_releases_url empty: status %v", got)
	}
}

func TestUpdateCheckOnAPackageInstallPointsAtTheRelease(t *testing.T) {
	gh := updatetest.New(t, fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	s, exe := updateServer(t, gh)
	s.upd.place = update.Place{Kind: update.KindPackage, Path: exe, Target: "linux-amd64", Reason: "installed from a package"}
	body := checkBody(t, s, fromPC("GET", "/update/check", ""))
	if body["status"] != "manual" || body["reason"] != "installed from a package" {
		t.Errorf("status %v reason %v", body["status"], body["reason"])
	}
	w := fromPC("POST", "/update/install", `{"build":"1.8.1-go-bbbbbbb","serial":2000}`).do(s)
	if w.Code != 409 {
		t.Errorf("install on a package install: %d, want 409", w.Code)
	}
}

func TestUpdateRoutesWhoMay(t *testing.T) {
	gh := updatetest.New(t, fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	s, exe := updateServer(t, gh)
	install := `{"build":"1.8.1-go-bbbbbbb","serial":2000}`

	crossSite := fromPC("GET", "/update/check", "")
	crossSite.origin, crossSite.fetchSite = "https://evil.example", "cross-site"
	if w := crossSite.do(s); w.Code != 403 {
		t.Errorf("a check from another website: %d, want 403", w.Code)
	}
	if w := fromPhone("POST", "/update/install", install).do(s); w.Code != 403 {
		t.Errorf("install from a phone: %d, want 403", w.Code)
	}
	noOrigin := fromPC("POST", "/update/install", install)
	noOrigin.origin = ""
	if w := noOrigin.do(s); w.Code != 403 {
		t.Errorf("install with no Origin: %d, want 403", w.Code)
	}
	evil := fromPC("POST", "/update/install", install)
	evil.origin, evil.fetchSite = "https://evil.example", "cross-site"
	if w := evil.do(s); w.Code != 403 {
		t.Errorf("install from another website: %d, want 403", w.Code)
	}
	if w := fromPhone("POST", "/update/restart", "").do(s); w.Code != 403 {
		t.Errorf("restart from a phone: %d, want 403", w.Code)
	}
	if w := fromPC("GET", "/update/install", "").do(s); w.Code != 405 {
		t.Errorf("GET install: %d, want 405", w.Code)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old program" {
		t.Error("a refused request changed the program")
	}
	if gh.Hits("/download/v1.8.1/GobboNet-v1.8.1-update.zip") != 0 {
		t.Error("a refused request downloaded something")
	}
}

func TestUpdateInstallOnlyWhatWasOffered(t *testing.T) {
	gh := updatetest.New(t, fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	s, exe := updateServer(t, gh)
	for _, body := range []string{
		`{"build":"1.8.1-go-other","serial":2000}`,
		`{"build":"1.8.1-go-bbbbbbb","serial":1999}`,
		`{"build":"1.7.9-go-ooooooo","serial":99999}`,
	} {
		if w := fromPC("POST", "/update/install", body).do(s); w.Code != 409 {
			t.Errorf("install %s: %d, want 409", body, w.Code)
		}
	}
	if b, _ := os.ReadFile(exe); string(b) != "old program" {
		t.Error("the program changed")
	}
}

func waitInstalled(t *testing.T, s *Server) map[string]any {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		st := checkBody(t, s, fromPC("GET", "/update/status", ""))
		switch st["state"] {
		case "installed", "failed":
			return st
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("the install never finished")
	return nil
}

func TestUpdateInstallAndRestart(t *testing.T) {
	gh := updatetest.New(t, fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	s, exe := updateServer(t, gh)
	restarted := make(chan struct{}, 1)

	// Before anything is installed there is nothing to restart into.
	s.SetRestart(func() { restarted <- struct{}{} })
	if w := fromPC("POST", "/update/restart", "").do(s); w.Code != 409 {
		t.Errorf("restart with nothing installed: %d, want 409", w.Code)
	}

	w := fromPC("POST", "/update/install", `{"build":"1.8.1-go-bbbbbbb","serial":2000}`).do(s)
	if w.Code != 202 {
		t.Fatalf("install: %d %s", w.Code, w.Body)
	}
	st := waitInstalled(t, s)
	if st["state"] != "installed" || st["build"] != "1.8.1-go-bbbbbbb" || st["can_restart"] != true {
		t.Fatalf("status = %v", st)
	}
	if b, _ := os.ReadFile(exe); string(b) != "program 1.8.1-go-bbbbbbb" {
		t.Errorf("the program is %q", b)
	}
	if _, err := os.Stat(exe + ".old"); err != nil {
		t.Error("the replaced program should wait beside the new one until the next start")
	}

	// A second install is refused until the restart.
	if w := fromPC("POST", "/update/install", `{"build":"1.8.1-go-bbbbbbb","serial":2000}`).do(s); w.Code != 409 {
		t.Errorf("a second install: %d, want 409", w.Code)
	}

	if w := fromPC("POST", "/update/restart", "").do(s); w.Code != 202 {
		t.Fatalf("restart: %d %s", w.Code, w.Body)
	}
	select {
	case <-restarted:
	case <-time.After(3 * time.Second):
		t.Fatal("RESTART NOW did not restart")
	}
}

func TestUpdateRestartWithoutARestarter(t *testing.T) {
	gh := updatetest.New(t, fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000))
	s, _ := updateServer(t, gh)
	fromPC("POST", "/update/install", `{"build":"1.8.1-go-bbbbbbb","serial":2000}`).do(s)
	if st := waitInstalled(t, s); st["can_restart"] != false {
		t.Errorf("can_restart = %v with no way to restart", st["can_restart"])
	}
	w := fromPC("POST", "/update/restart", "").do(s)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "start it again") {
		t.Errorf("restart with no restarter: %d %s", w.Code, w.Body)
	}
}

func TestUpdateInstallFailureKeepsTheProgram(t *testing.T) {
	r := fakeRelease("v1.8.1", "1.8.1-go-bbbbbbb", 2000)
	// The signed file pins a program other than the one in the ZIP.
	tgt := r.Manifest.Targets["linux-amd64"]
	tgt.MemberSHA256 = strings.Repeat("0", 64)
	r.Manifest.Targets["linux-amd64"] = tgt
	gh := updatetest.New(t, r)
	s, exe := updateServer(t, gh)
	fromPC("POST", "/update/install", `{"build":"1.8.1-go-bbbbbbb","serial":`+strconv.Itoa(2000)+`}`).do(s)
	st := waitInstalled(t, s)
	if st["state"] != "failed" || !strings.Contains(st["error"].(string), "does not match") {
		t.Errorf("status = %v", st)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old program" {
		t.Error("a failed install changed the program")
	}
	// After a failure the button can be pressed again.
	if w := fromPC("POST", "/update/install", `{"build":"1.8.1-go-bbbbbbb","serial":2000}`).do(s); w.Code != 202 {
		t.Errorf("retry after a failure: %d", w.Code)
	}
	waitInstalled(t, s)
}
