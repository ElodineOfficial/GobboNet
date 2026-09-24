package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/atomicfile"
	"github.com/ElodineOfficial/GobboNet/internal/auth"
	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/keyring"
	"golang.org/x/term"
)

// keyringMarker replaces the Argon2id hash in access_secret while encryption is
// on, because the keyslot is the verifier and a second one would be an
// offline-crackable copy of the answer sitting in a plaintext file.
//
// It is also load-bearing in the other direction. auth.SecretConfigured only
// recognises "$argon2id$..." and the legacy salt:hash pair, so a build that
// predates all this finds a secret it calls malformed and refuses to start --
// rather than serving an encrypted history it cannot read, or overwriting it.
const keyringMarker = "$gobbonet-keyring$"

// --- dispatch --------------------------------------------------------------

func cmdKeyring(argv []string) error {
	if len(argv) == 0 {
		keyringUsage()
		return errors.New("keyring needs a subcommand")
	}
	sub, rest := argv[0], argv[1:]
	switch sub {
	case "init":
		return keyringInit(rest)
	case "list", "status":
		return keyringList(rest)
	case "set-recovery":
		return keyringSetRecovery(rest)
	case "recover":
		return keyringRecover(rest)
	case "help", "-h", "--help":
		keyringUsage()
		return nil
	default:
		keyringUsage()
		return fmt.Errorf("unknown keyring subcommand %q", sub)
	}
}

func keyringUsage() {
	fmt.Print(`gobbonet keyring - manage the key that encrypts your history

  gobbonet keyring init           encrypt this install's history
  gobbonet keyring list           show the ways in, without opening anything
  gobbonet keyring set-recovery   replace the recovery phrase (needs the password)
  gobbonet keyring recover        forgot the password: phrase in, new password out
  gobbonet decrypt                go back to storing history in plaintext

Changing the password is still 'gobbonet set-password'; on an encrypted
install it reseals the key rather than writing a new hash.
`)
}

// --- helpers ---------------------------------------------------------------

// stateFiles lists the shared state.json and every state-<profile>.json beside
// it. One keyring covers all of them.
func stateFiles(cfg config.Config) ([]string, error) {
	shared := cfg.StatePath()
	dir := filepath.Dir(shared)
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var out []string
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if name == "state.json" || (strings.HasPrefix(name, "state-") && strings.HasSuffix(name, ".json")) {
			out = append(out, filepath.Join(dir, name))
		}
	}
	sort.Strings(out)
	return out, nil
}

// readLine reads a line with echo on.
//
// Deliberately not a hidden prompt. A recovery phrase is being copied off paper
// by someone who has already had a bad morning, and hiding it turns one
// mistyped letter into an unexplainable refusal. They are at the machine; the
// threat we are defending against is not somebody reading over their shoulder.
func readLine(prompt string) (string, error) {
	fmt.Print(prompt)
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		if err := sc.Err(); err != nil {
			return "", err
		}
		return "", errors.New("nothing to read on standard input")
	}
	return strings.TrimSpace(sc.Text()), nil
}

func interactive() bool { return term.IsTerminal(int(os.Stdin.Fd())) }

// showPhrase prints a new recovery phrase and, when there is somebody there to
// ask, checks that it was actually written down.
//
// The check exists because the phrase is shown exactly once. Only the keyslot
// is stored, so no command here can print it again -- not with root, not with
// the password. Asking for three words back costs ten seconds and is the
// difference between a phrase on paper and a phrase in a terminal that gets
// closed.
func showPhrase(p keyring.Phrase) error {
	words := p.Words()
	fmt.Println()
	fmt.Println("  ==================================================")
	fmt.Println("   YOUR RECOVERY PHRASE -- WRITE THIS DOWN NOW")
	fmt.Println()
	const perRow = 4
	for i := 0; i < len(words); i += perRow {
		var row strings.Builder
		row.WriteString("    ")
		for j := i; j < i+perRow && j < len(words); j++ {
			fmt.Fprintf(&row, " %d. %-10s", j+1, words[j])
		}
		fmt.Println(strings.TrimRight(row.String(), " "))
	}
	fmt.Println()
	fmt.Println("   This is the only time it will be shown. Only its")
	fmt.Println("   keyslot is stored, so nothing can print it again.")
	fmt.Println()
	fmt.Println("   Print it or photograph it and keep it away from")
	fmt.Println("   this machine. Anyone holding it can read your")
	fmt.Println("   history. Without it, a forgotten password means")
	fmt.Println("   the history is gone.")
	fmt.Println("  ==================================================")
	fmt.Println()

	if !interactive() {
		return nil
	}
	for _, pos := range confirmPositions(len(words)) {
		for {
			got, err := readLine(fmt.Sprintf("  To confirm you have it, type word %d: ", pos+1))
			if err != nil {
				return err
			}
			if strings.EqualFold(strings.TrimSpace(got), words[pos]) {
				break
			}
			fmt.Println("  That is not word", pos+1, "-- check your copy and try again.")
		}
	}
	fmt.Println("  [OK] Recovery phrase confirmed.")
	fmt.Println()
	return nil
}

// confirmPositions picks three spread-out words to ask back, so the check
// cannot be passed by reading only the start of the line.
func confirmPositions(n int) []int {
	if n < 3 {
		return []int{0}
	}
	return []int{0, n / 2, n - 1}
}

// readPhrase reads and parses a recovery phrase, explaining what is wrong until
// it is right.
func readPhrase(prompt string) (keyring.Phrase, error) {
	for attempt := 0; ; attempt++ {
		line, err := readLine(prompt)
		if err != nil {
			return keyring.Phrase{}, err
		}
		p, err := keyring.ParsePhrase(line)
		if err == nil {
			return p, nil
		}
		fmt.Printf("  %v\n", err)
		if !interactive() {
			return keyring.Phrase{}, err
		}
		if attempt >= 4 {
			return keyring.Phrase{}, errors.New("giving up after five attempts at the recovery phrase")
		}
	}
}

// sealAll writes every state file through the key. Files already sealed under
// this key are left alone.
func sealAll(cfg config.Config, k *keyring.Keyring) (int, error) {
	files, err := stateFiles(cfg)
	if err != nil {
		return 0, err
	}
	sealed := 0
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return sealed, fmt.Errorf("reading %s: %w", f, err)
		}
		if keyring.IsSealed(raw) {
			continue
		}
		body, err := k.Seal(raw)
		if err != nil {
			return sealed, fmt.Errorf("sealing %s: %w", f, err)
		}
		if err := atomicfile.Write(f, body, 0o600); err != nil {
			return sealed, fmt.Errorf("writing %s: %w", f, err)
		}
		fmt.Printf("  [OK] encrypted %s\n", f)
		sealed++
	}
	return sealed, nil
}

// --- init ------------------------------------------------------------------

func keyringInit(argv []string) error {
	fs := flag.NewFlagSet("gobbonet keyring init", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if keyring.Exists(cfg.KeyringPath()) {
		return fmt.Errorf("this install is already encrypted (%s).\n"+
			"      To change the password: gobbonet set-password\n"+
			"      To replace the recovery phrase: gobbonet keyring set-recovery", cfg.KeyringPath())
	}
	if !interactive() {
		return errors.New("keyring init needs a terminal: it sets a password and shows a recovery phrase once")
	}

	fmt.Println()
	fmt.Println("  Encrypting this install's chat history.")
	fmt.Println()
	fmt.Println("  Your GobboNet password becomes the key. There is only ever")
	fmt.Println("  one password: the one you type in the browser is the one")
	fmt.Println("  that unlocks the files.")
	fmt.Println()
	fmt.Println("  The config file stays readable, so the server still starts")
	fmt.Println("  on its own -- but it cannot read your history until someone")
	fmt.Println("  signs in. After a restart, that means signing in again.")
	fmt.Println()

	password, err := confirmedPassword(&cfg)
	if err != nil {
		return err
	}

	k, phrase, err := keyring.Create(cfg.KeyringPath(), password)
	if err != nil {
		return err
	}
	fmt.Printf("  [OK] keyring written to %s\n", cfg.KeyringPath())

	if _, err := sealAll(cfg, k); err != nil {
		return fmt.Errorf("the keyring was created but the history could not all be encrypted: %w.\n"+
			"      Nothing was lost -- rerun this command, or 'gobbonet decrypt' to undo it", err)
	}

	// Last, so a failure above leaves an install that still starts normally.
	if err := config.Set(cfg.Path, "access_secret", keyringMarker); err != nil {
		return fmt.Errorf("could not point %s at the keyring: %w", cfg.Path, err)
	}
	fmt.Printf("  [OK] %s now defers to the keyring for the password\n", cfg.Path)

	return showPhrase(phrase)
}

// confirmedPassword asks twice and returns the agreed password.
func confirmedPassword(cfg *config.Config) (string, error) {
	for {
		first, err := readPassword("  Choose the password: ")
		if err != nil {
			return "", err
		}
		if len(first) < minPasswordLength {
			fmt.Printf("  Too short -- use at least %d characters.\n", minPasswordLength)
			continue
		}
		second, err := readPassword("  Confirm password:   ")
		if err != nil {
			return "", err
		}
		if first != second {
			fmt.Println("  Passwords did not match -- try again.")
			continue
		}
		return first, nil
	}
}

// --- list ------------------------------------------------------------------

func keyringList(argv []string) error {
	fs := flag.NewFlagSet("gobbonet keyring list", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}

	info, err := keyring.Describe(cfg.KeyringPath())
	if errors.Is(err, keyring.ErrNoKeyring) {
		fmt.Println()
		fmt.Println("  Encryption: off. History is stored as plain JSON.")
		fmt.Printf("  Files:      %s\n", filepath.Dir(cfg.StatePath()))
		fmt.Println()
		fmt.Println("  To turn it on: gobbonet keyring init")
		return nil
	}
	if err != nil {
		return err
	}

	fmt.Println()
	fmt.Printf("  Encryption: on\n")
	fmt.Printf("  Keyring:    %s\n", cfg.KeyringPath())
	fmt.Printf("  Data key:   %s\n", info.DEKID)
	fmt.Printf("  Ways in:    %d\n", len(info.Kinds))
	for _, kind := range info.Kinds {
		switch kind {
		case keyring.SlotPassword:
			fmt.Println("              - password (the one you sign in with)")
		case keyring.SlotRecovery:
			fmt.Println("              - recovery phrase")
		default:
			fmt.Printf("              - %s\n", kind)
		}
	}

	var hasRecovery bool
	for _, kind := range info.Kinds {
		if kind == keyring.SlotRecovery {
			hasRecovery = true
		}
	}
	if !hasRecovery {
		fmt.Println()
		fmt.Println("  [!] There is one way in. If you forget this password the")
		fmt.Println("      history cannot be read by anyone, including us.")
		fmt.Println("      Run: gobbonet keyring set-recovery")
	}

	files, err := stateFiles(cfg)
	if err != nil {
		return err
	}
	var plaintext []string
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		if !keyring.IsSealed(raw) {
			plaintext = append(plaintext, f)
		}
	}
	if len(plaintext) > 0 {
		fmt.Println()
		fmt.Println("  [!] Encrypted install, but these are still plaintext:")
		for _, f := range plaintext {
			fmt.Printf("        %s\n", f)
		}
		fmt.Println("      Each will be sealed the next time it is written, or")
		fmt.Println("      run 'gobbonet keyring init' again to do it now.")
	}
	fmt.Println()
	return nil
}

// --- set-recovery ----------------------------------------------------------

func keyringSetRecovery(argv []string) error {
	fs := flag.NewFlagSet("gobbonet keyring set-recovery", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if !keyring.Exists(cfg.KeyringPath()) {
		return errors.New("this install is not encrypted, so there is no recovery phrase.\n      To turn encryption on: gobbonet keyring init")
	}
	if !interactive() {
		return errors.New("set-recovery needs a terminal: it shows the new phrase once")
	}

	password, err := readPassword("  Current password: ")
	if err != nil {
		return err
	}
	k, err := keyring.UnlockPassword(cfg.KeyringPath(), password)
	if err != nil {
		return err
	}

	fmt.Println()
	fmt.Println("  Any previous recovery phrase stops working now.")
	phrase, err := k.SetRecovery()
	if err != nil {
		return err
	}
	return showPhrase(phrase)
}

// --- recover ---------------------------------------------------------------

func keyringRecover(argv []string) error {
	fs := flag.NewFlagSet("gobbonet keyring recover", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if !keyring.Exists(cfg.KeyringPath()) {
		return errors.New("this install is not encrypted, so there is nothing to recover.\n      If you cannot sign in, run: gobbonet set-password")
	}
	if !interactive() {
		return errors.New("recover needs a terminal")
	}

	fmt.Println()
	fmt.Println("  Recovering access with your recovery phrase.")
	fmt.Println()
	fmt.Println("  This replaces both the password and the phrase. It does not")
	fmt.Println("  touch your history: only the small keyring file is rewritten,")
	fmt.Println("  so it takes the same moment whether you have ten conversations")
	fmt.Println("  or ten thousand.")
	fmt.Println()
	fmt.Println("  Case and spacing do not matter, and the first four letters of")
	fmt.Println("  each word are enough.")
	fmt.Println()

	phrase, err := readPhrase("  Recovery phrase: ")
	if err != nil {
		return err
	}
	k, err := keyring.UnlockPhrase(cfg.KeyringPath(), phrase)
	if err != nil {
		if errors.Is(err, keyring.ErrWrongCredential) {
			return errors.New("that is a valid recovery phrase, but not this install's one")
		}
		return err
	}
	fmt.Println("  [OK] Unlocked.")
	fmt.Println()

	password, err := confirmedPassword(&cfg)
	if err != nil {
		return err
	}
	if err := k.SetPassword(password); err != nil {
		return err
	}
	fmt.Println("  [OK] Password reset. The old one no longer works.")

	// The phrase just travelled from paper to a terminal, so it is replaced as
	// a matter of course. Using it never required burning it -- we burn it
	// because it has been handled.
	fresh, err := k.SetRecovery()
	if err != nil {
		return err
	}
	fmt.Println("  [OK] The phrase you just used no longer works. Here is its replacement.")

	// Only now, in case the install predates the marker.
	if err := config.Set(cfg.Path, "access_secret", keyringMarker); err != nil {
		return fmt.Errorf("could not point %s at the keyring: %w", cfg.Path, err)
	}
	return showPhrase(fresh)
}

// --- decrypt ---------------------------------------------------------------

func cmdDecrypt(argv []string) error {
	fs := flag.NewFlagSet("gobbonet decrypt", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	yes := fs.Bool("yes", false, "do not ask for confirmation")
	if err := fs.Parse(argv); err != nil {
		return err
	}
	cfg, err := loadConfig(*configPath)
	if err != nil {
		return err
	}
	if !keyring.Exists(cfg.KeyringPath()) {
		return errors.New("this install is not encrypted")
	}

	fmt.Println()
	fmt.Println("  This writes your entire history back to disk as plain JSON.")
	fmt.Println()
	fmt.Println("  Note that it does not un-write what is already there: the")
	fmt.Println("  encrypted blocks stay on the disk until the filesystem reuses")
	fmt.Println("  them. Re-encrypting later does not erase the plaintext this")
	fmt.Println("  leaves behind either. This is a one-way door for the copy on")
	fmt.Println("  this machine.")
	fmt.Println()
	fmt.Println("  If you only want a new password, that is 'gobbonet set-password'")
	fmt.Println("  and it keeps everything encrypted.")
	fmt.Println()

	if !*yes {
		if !interactive() {
			return errors.New("refusing to decrypt without confirmation; pass --yes if that is really what you want")
		}
		answer, err := readLine("  Type 'decrypt' to continue: ")
		if err != nil {
			return err
		}
		if !strings.EqualFold(answer, "decrypt") {
			return errNotice{msg: "Nothing was changed."}
		}
	}

	password, err := readPassword("  Current password: ")
	if err != nil {
		return err
	}
	k, err := keyring.UnlockPassword(cfg.KeyringPath(), password)
	if err != nil {
		return err
	}

	files, err := stateFiles(cfg)
	if err != nil {
		return err
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			return fmt.Errorf("reading %s: %w", f, err)
		}
		if !keyring.IsSealed(raw) {
			continue
		}
		plain, err := k.Unseal(raw)
		if err != nil {
			return fmt.Errorf("decrypting %s: %w", f, err)
		}
		if err := atomicfile.Write(f, plain, 0o600); err != nil {
			return fmt.Errorf("writing %s: %w", f, err)
		}
		fmt.Printf("  [OK] decrypted %s\n", f)
	}

	// The password becomes an ordinary stored hash again before the keyring
	// goes, so there is never a moment with no way to sign in.
	secret, err := auth.NewSecret(password)
	if err != nil {
		return err
	}
	if err := config.Set(cfg.Path, "access_secret", secret); err != nil {
		return fmt.Errorf("could not restore the password hash in %s: %w", cfg.Path, err)
	}
	if err := os.Remove(cfg.KeyringPath()); err != nil {
		return fmt.Errorf("history is decrypted and the password is restored, but the keyring could not be removed: %w", err)
	}

	fmt.Println()
	fmt.Println("  [OK] Encryption is off. Your password is unchanged.")
	fmt.Println()
	return nil
}
