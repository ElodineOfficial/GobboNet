package main

// The update button's command-line half (1.8.0):
//
//   - `gobbonet update check` asks the release list what the page would.
//   - `gobbonet update keygen | manifest | sign | verify` are the
//     maintainer's tools for publishing a release the button can install
//     (docs/UPDATES.md; scripts/make-update-manifest.sh runs them).
//   - The restart into an installed update, and clearing what the update
//     left behind on the next start.

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/update"
	"github.com/ElodineOfficial/GobboNet/internal/version"
)

// errRestart is cmdServe's way out when RESTART NOW was pressed: returned
// rather than acted on there, so that every deferred clean-up -- the engine,
// the history lock, the console -- has run before the new program starts.
// main acts on it.
type errRestart struct {
	path string
	args []string
}

func (e errRestart) Error() string { return "restarting into " + e.path }

// exitRestarted is this process's exit code when it has started the updated
// program in its place (Windows). launch.bat looks for it.
const exitRestarted = 3

// restartArgs is how the new program is started: as this one was, without
// what only made sense the first time. A browser tab is already open on the
// page, which reloads itself, so --open goes, and `launch` gets --no-browser;
// --setup would run first-time setup again.
func restartArgs(argv []string) []string {
	var out []string
	launch := false
	for i, a := range argv {
		switch strings.TrimLeft(a, "-") {
		case "open", "open=true", "setup", "setup=true":
			if strings.HasPrefix(a, "-") {
				continue
			}
		}
		if i == 0 && a == "launch" {
			launch = true
		}
		out = append(out, a)
	}
	if launch {
		has := false
		for _, a := range out {
			if strings.TrimLeft(a, "-") == "no-browser" {
				has = true
			}
		}
		if !has {
			out = append(out, "--no-browser")
		}
	}
	return out
}

// restartEnv is this environment without the marker launch.bat sets to say
// it printed the banner: the new program should say what it is.
func restartEnv() []string {
	var out []string
	for _, kv := range os.Environ() {
		if strings.HasPrefix(kv, "GOBBONET_BANNER_SHOWN=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// finishUpdate removes what an earlier update left beside the program, once
// this one is serving: the program it replaced, which was kept until the new
// one had started. On Windows that program may still be exiting for a moment,
// so whatever cannot be removed yet is tried again for a minute.
func finishUpdate(w io.Writer, place update.Place) {
	if !place.CanInstall() {
		return
	}
	removed, left := update.CleanupOld(place.Path)
	for _, r := range removed {
		if strings.Contains(filepath.Base(r), ".old") {
			fmt.Fprintf(w, " [OK] update finished (version %s); the program it replaced has been removed\n", version.String())
			break
		}
	}
	if len(left) == 0 {
		return
	}
	go func() {
		for i := 0; i < 30 && len(left) > 0; i++ {
			time.Sleep(2 * time.Second)
			_, left = update.CleanupOld(place.Path)
		}
	}()
}

// --- gobbonet version --json ----------------------------------------------

// printVersionJSON is what the updater runs a new program with before it is
// put in place: proof that it starts, and which build it is.
func printVersionJSON(w io.Writer) {
	out, _ := json.Marshal(update.Stamp{
		Build:   version.String(),
		Version: version.Release(),
		Serial:  version.SerialNumber(),
		GOOS:    runtime.GOOS,
		GOARCH:  runtime.GOARCH,
	})
	fmt.Fprintln(w, string(out))
}

// --- gobbonet update ... ---------------------------------------------------

func cmdUpdate(argv []string) error {
	if len(argv) == 0 {
		return errors.New("usage: gobbonet update check|keygen|manifest|sign|verify (see docs/UPDATES.md)")
	}
	switch argv[0] {
	case "check":
		return cmdUpdateCheck(argv[1:])
	case "keygen":
		return cmdUpdateKeygen(argv[1:])
	case "manifest":
		return cmdUpdateManifest(argv[1:])
	case "sign":
		return cmdUpdateSign(argv[1:])
	case "verify":
		return cmdUpdateVerify(argv[1:])
	}
	return fmt.Errorf("unknown update command %q: use check, keygen, manifest, sign or verify", argv[0])
}

func cmdUpdateCheck(argv []string) error {
	fs := flag.NewFlagSet("gobbonet update check", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	cur := update.Current()
	place := update.Locate()
	fmt.Printf("this build:   %s (serial %d)\n", cur.Build, cur.Serial)
	fmt.Printf("this install: %s, %s\n", place.Kind, place.Target)
	if place.Reason != "" {
		fmt.Printf("              %s\n", place.Reason)
	}
	if !cur.Updatable() {
		fmt.Println("an unstamped build (dev) is never updated")
		return nil
	}
	keys := update.TrustedKeys()
	checker := &update.Checker{ReleasesURL: cfg.UpdateReleasesURL, Keys: keys}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	res, err := checker.Check(ctx, cur, place.Target)
	if err != nil {
		return err
	}
	for _, n := range res.Notes {
		fmt.Printf("note:         %s\n", n)
	}
	switch {
	case len(keys) == 0:
		fmt.Printf("newest:       %s %s (not checked: this build has no signing key)\n", res.NewestTag, res.NewestPage)
	case res.Offer == nil:
		fmt.Println("up to date")
	default:
		o := res.Offer
		fmt.Printf("update:       %s (serial %d) from %s\n", o.Manifest.Build, o.Manifest.Serial, o.Tag)
		if o.TargetKey == "" {
			fmt.Printf("              nothing in it for %s\n", place.Target)
		} else {
			fmt.Printf("              %s, %d bytes\n", o.Target.Asset, o.Target.Size)
		}
	}
	return nil
}

func cmdUpdateKeygen(argv []string) error {
	fs := flag.NewFlagSet("gobbonet update keygen", flag.ContinueOnError)
	out := stringFlag(fs, "out", "where to write the private key (must not exist)")
	comment := fs.String("comment", "", "a note for the public key line (default: gobbonet-update and today's date)")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	if *out == "" {
		return errors.New("say where to write the private key: gobbonet update keygen --out PATH (somewhere outside the repository)")
	}
	text, pub, err := update.GenerateKey()
	if err != nil {
		return err
	}
	f, err := os.OpenFile(*out, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fmt.Errorf("could not create %s: %v (an existing key is never overwritten)", *out, err)
	}
	if _, err := f.WriteString(text); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if *comment == "" {
		*comment = "gobbonet-update " + time.Now().Format("2006-01-02")
	}
	fmt.Printf(" [OK] private key written to %s\n", *out)
	fmt.Println("      Keep it off GitHub and out of every release: whoever has it can sign an update")
	fmt.Println("      that every GobboNet trusting this key will install. Back it up; without it, builds")
	fmt.Println("      carrying this key can only be updated by hand.")
	fmt.Println()
	fmt.Println(" Add this line to internal/update/trusted-keys.txt and commit it BEFORE building the")
	fmt.Println(" release that should be able to install updates:")
	fmt.Println()
	fmt.Println("   " + update.PublicKeyLine(pub, *comment))
	return nil
}

// kvList is a repeated KEY=VALUE flag.
type kvList []string

func (k *kvList) String() string     { return strings.Join(*k, ",") }
func (k *kvList) Set(v string) error { *k = append(*k, v); return nil }

func cmdUpdateManifest(argv []string) error {
	fs := flag.NewFlagSet("gobbonet update manifest", flag.ContinueOnError)
	out := stringFlag(fs, "out", "where to write gobbonet-update.json")
	var targets, members kvList
	fs.Var(&targets, "target", "PLATFORM=FILE: a file attached to the release, e.g. windows-amd64=dist/GobboNet-1_8_0-update.zip (repeat)")
	fs.Var(&members, "member", "PLATFORM=PATH: the program's path inside that platform's archive, e.g. windows-amd64=GobboNet/gobbonet.exe (repeat)")
	notes := fs.String("notes", "", "a short description shown before installing")
	notesFile := stringFlag(fs, "notes-file", "read the description from a file")
	notesURL := stringFlag(fs, "notes-url", "an https page with the full release notes")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	if *out == "" || len(targets) == 0 {
		return errors.New("usage: gobbonet update manifest --out FILE --target PLATFORM=FILE [--member PLATFORM=PATH]...")
	}
	if *notesFile != "" {
		raw, err := os.ReadFile(*notesFile)
		if err != nil {
			return err
		}
		*notes = string(raw)
	}
	memberOf := map[string]string{}
	for _, m := range members {
		k, v, ok := strings.Cut(m, "=")
		if !ok {
			return fmt.Errorf("--member %q: want PLATFORM=PATH", m)
		}
		memberOf[k] = v
	}
	in := update.ManifestInput{Notes: *notes, NotesURL: *notesURL, Published: time.Now()}
	for _, t := range targets {
		k, v, ok := strings.Cut(t, "=")
		if !ok {
			return fmt.Errorf("--target %q: want PLATFORM=FILE", t)
		}
		in.Targets = append(in.Targets, update.TargetInput{Key: k, Asset: v, Member: memberOf[k]})
		delete(memberOf, k)
	}
	for k := range memberOf {
		if k != "" {
			return fmt.Errorf("--member %s has no --target", k)
		}
	}
	m, err := update.BuildManifest(in)
	if err != nil {
		return err
	}
	raw, err := update.EncodeManifest(m)
	if err != nil {
		return err
	}
	if err := os.WriteFile(*out, raw, 0o644); err != nil {
		return err
	}
	fmt.Printf(" [OK] %s: %s (serial %d)\n", *out, m.Build, m.Serial)
	for k, t := range m.Targets {
		fmt.Printf("      %-15s %s\n", k, t.Asset)
	}
	fmt.Println("      Sign it next: gobbonet update sign --key PATH " + *out)
	return nil
}

func cmdUpdateSign(argv []string) error {
	fs := flag.NewFlagSet("gobbonet update sign", flag.ContinueOnError)
	keyPath := stringFlag(fs, "key", "the private key file from `gobbonet update keygen`")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	if *keyPath == "" || fs.NArg() != 1 {
		return errors.New("usage: gobbonet update sign --key PATH gobbonet-update.json")
	}
	file := fs.Arg(0)
	keyText, err := os.ReadFile(*keyPath)
	if err != nil {
		return err
	}
	priv, err := update.ParsePrivateKey(string(keyText))
	if err != nil {
		return err
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	m, err := update.ParseManifest(raw)
	if err != nil {
		return err
	}
	sig := update.Sign(priv, raw)
	if err := os.WriteFile(file+".sig", []byte(sig), 0o644); err != nil {
		return err
	}
	fmt.Printf(" [OK] %s.sig: signs %s (serial %d)\n", file, m.Build, m.Serial)
	pub, _ := priv.Public().(ed25519.PublicKey)
	if err := update.Verify(raw, []byte(sig), update.TrustedKeys()); err != nil {
		fmt.Printf(" [!]  This program does not trust that key (%v).\n", err)
		fmt.Println("      Only builds whose internal/update/trusted-keys.txt has this line will install the release:")
		fmt.Println("        " + update.PublicKeyLine(pub, ""))
	} else {
		fmt.Println("      This program trusts the key that signed it.")
	}
	fmt.Println("      Attach both files to the GitHub release, beside the downloads they name.")
	return nil
}

func cmdUpdateVerify(argv []string) error {
	if len(argv) != 1 {
		return errors.New("usage: gobbonet update verify gobbonet-update.json (with its .sig beside it)")
	}
	raw, err := os.ReadFile(argv[0])
	if err != nil {
		return err
	}
	sig, err := os.ReadFile(argv[0] + ".sig")
	if err != nil {
		return err
	}
	if err := update.Verify(raw, sig, update.TrustedKeys()); err != nil {
		return err
	}
	m, err := update.ParseManifest(raw)
	if err != nil {
		return err
	}
	fmt.Printf(" [OK] signed by a key this build trusts: %s (serial %d)\n", m.Build, m.Serial)
	for k, t := range m.Targets {
		fmt.Printf("      %-15s %s (%d bytes)\n", k, t.Asset, t.Size)
	}
	return nil
}
