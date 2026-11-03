package main

import (
	"bytes"
	"errors"
	"strings"
	"testing"
)

// Real netsh output shape: blank-line-separated stanzas, field labels that
// Windows translates, values that it does not.
const fwEnglish = `
Rule Name:                            GobboNet
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Private
Program:                              C:\Users\a\GobboNet\gobbonet.exe
Action:                               Block

Rule Name:                            GobboNet
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
Profiles:                             Public
Program:                              C:\Users\a\GobboNet\gobbonet.exe
Action:                               Block

Rule Name:                            Gemma4-Web
----------------------------------------------------------------------
Enabled:                              Yes
Direction:                            In
LocalPort:                            9066
Action:                               Allow
`

// German labels, identical values. setup-lan.bat carries a long comment about
// having shipped a check that matched an English netsh header and therefore
// reported success on every localised Windows. This parse must not repeat it,
// so it keys on the program path and the action keyword, neither of which is
// translated.
const fwGerman = `
Regelname:                            GobboNet
----------------------------------------------------------------------
Aktiviert:                            Ja
Richtung:                             Eingehend
Programm:                             C:\Users\a\GobboNet\gobbonet.exe
Aktion:                               Block
`

// TestCountsBothBlockRules covers the shape Windows actually writes when the
// "Allow access?" prompt is dismissed: one rule per profile, both blocking.
func TestCountsBothBlockRules(t *testing.T) {
	if n := countBlockedGobbonetRules(fwEnglish); n != 2 {
		t.Errorf("got %d, want 2", n)
	}
}

func TestSurvivesLocalisedLabels(t *testing.T) {
	if n := countBlockedGobbonetRules(fwGerman); n != 1 {
		t.Errorf("got %d, want 1", n)
	}
}

// TestAllowRulesAreNotCounted -- a false positive here would send someone
// deleting the rule that makes their install work.
func TestAllowRulesAreNotCounted(t *testing.T) {
	allow := "Rule Name: GobboNet\nProgram: C:\\x\\gobbonet.exe\nAction: Allow\n"
	if n := countBlockedGobbonetRules(allow); n != 0 {
		t.Errorf("got %d, want 0", n)
	}
}

func TestUnrelatedBlockRulesAreNotCounted(t *testing.T) {
	other := "Rule Name: SomethingElse\nProgram: C:\\x\\other.exe\nAction: Block\n"
	if n := countBlockedGobbonetRules(other); n != 0 {
		t.Errorf("got %d, want 0", n)
	}
}

// TestCRLFInput -- netsh emits CRLF, so a parse that splits on "\n\n" sees one
// stanza and counts one rule where there are several.
func TestCRLFInput(t *testing.T) {
	crlf := "Rule Name: GobboNet\r\nProgram: C:\\x\\gobbonet.exe\r\nAction: Block\r\n" +
		"\r\nRule Name: Other\r\nAction: Allow\r\n"
	if n := countBlockedGobbonetRules(crlf); n != 1 {
		t.Errorf("got %d, want 1", n)
	}
}

// --- The port rule's name -----------------------------------------------------

// fakeNetsh answers `netsh advfirewall firewall show rule name=X` from a map,
// the way netsh does: a rule it has prints its stanza, one it lacks prints a
// message and exits 1.
func fakeNetsh(rules map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if out, ok := rules[name]; ok {
			return out, nil
		}
		return "No rules match the specified criteria.\r\n", errors.New("exit status 1")
	}
}

func portRuleReport(port int, show func(string) (string, error)) string {
	var b bytes.Buffer
	reportPortRule(&b, port, show)
	return b.String()
}

const webRule9066 = "Rule Name: X\r\nLocalPort: 9066\r\nAction: Allow\r\n"

// TestPortRuleNewName -- what setup-lan.bat creates from 1.7.8 on (issue #63).
func TestPortRuleNewName(t *testing.T) {
	out := portRuleReport(9066, fakeNetsh(map[string]string{"GobboNet-Web": webRule9066}))
	if !strings.Contains(out, "rule GobboNet-Web present for port 9066") || strings.Contains(out, "old name") {
		t.Errorf("got:\n%s", out)
	}
}

// TestPortRuleOldNameStillCounts -- an install that has not re-run
// setup-lan.bat since the rename still has a working Gemma4-Web rule. Calling
// that "NO RULE" would send someone to fix a firewall that is fine.
func TestPortRuleOldNameStillCounts(t *testing.T) {
	out := portRuleReport(9066, fakeNetsh(map[string]string{"Gemma4-Web": webRule9066}))
	if !strings.Contains(out, "rule Gemma4-Web present for port 9066") || !strings.Contains(out, "old name") ||
		strings.Contains(out, "NO RULE") {
		t.Errorf("got:\n%s", out)
	}
}

func TestPortRulePrefersNewName(t *testing.T) {
	out := portRuleReport(9066, fakeNetsh(map[string]string{"GobboNet-Web": webRule9066, "Gemma4-Web": webRule9066}))
	if !strings.Contains(out, "rule GobboNet-Web present") || strings.Contains(out, "Gemma4-Web") {
		t.Errorf("got:\n%s", out)
	}
}

func TestPortRuleMissingOrWrongPort(t *testing.T) {
	if out := portRuleReport(9066, fakeNetsh(nil)); !strings.Contains(out, "NO RULE for this port") {
		t.Errorf("no rules: got:\n%s", out)
	}
	wrong := "Rule Name: X\r\nLocalPort: 9070\r\nAction: Allow\r\n"
	out := portRuleReport(9066, fakeNetsh(map[string]string{"GobboNet-Web": wrong, "Gemma4-Web": wrong}))
	if !strings.Contains(out, "NO RULE for this port") {
		t.Errorf("rules for another port: got:\n%s", out)
	}
}

func TestPortRuleNoNetsh(t *testing.T) {
	out := portRuleReport(9066, func(string) (string, error) { return "", errors.New("executable file not found") })
	if !strings.Contains(out, "could not run netsh") {
		t.Errorf("got:\n%s", out)
	}
}

// --- Linux ------------------------------------------------------------------

// TestUfwEnabledParsesConf -- /etc/ufw/ufw.conf is world-readable and
// `ufw status` is not, so this is the only ufw signal available to a doctor
// run without sudo. A check that only works under sudo is a check most people
// never run.
func TestUfwEnabledParsesConf(t *testing.T) {
	on := "# comment\nENABLED=yes\nLOGLEVEL=low\n"
	if !ufwEnabled(on) {
		t.Error("ENABLED=yes read as disabled")
	}
	off := "ENABLED=no\n"
	if ufwEnabled(off) {
		t.Error("ENABLED=no read as enabled")
	}
	if ufwEnabled("#ENABLED=yes\n") {
		t.Error("commented-out ENABLED counted")
	}
	if ufwEnabled("") {
		t.Error("empty conf read as enabled")
	}
}

const ufwStatus = `Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
9066/tcp                   ALLOW       192.168.1.0/24
`

func TestUfwAllowsPort(t *testing.T) {
	if !ufwAllowsPort(ufwStatus, 9066) {
		t.Error("9066 is allowed and was not detected")
	}
	if ufwAllowsPort(ufwStatus, 8080) {
		t.Error("8080 is not in the table")
	}
}

// TestUfwPortMatchIsNotASubstring -- searching for "906" inside "9066/tcp"
// would report an open port that is nothing of the kind, and send triage away
// from the actual cause.
func TestUfwPortMatchIsNotASubstring(t *testing.T) {
	if ufwAllowsPort("19066/tcp                  ALLOW       Anywhere\n", 9066) {
		t.Error("19066 matched a request for 9066")
	}
	if ufwAllowsPort("906/tcp                    ALLOW       Anywhere\n", 9066) {
		t.Error("906 matched a request for 9066")
	}
}

// TestUfwDenyIsNotAnAllow -- a DENY row names the port too.
func TestUfwDenyIsNotAnAllow(t *testing.T) {
	if ufwAllowsPort("9066/tcp                   DENY        Anywhere\n", 9066) {
		t.Error("a DENY rule was read as permission")
	}
}

func TestFirewalldAllowsPort(t *testing.T) {
	if !firewalldAllowsPort("9066/tcp 5353/udp", 9066) {
		t.Error("9066/tcp not detected")
	}
	if firewalldAllowsPort("5353/udp", 9066) {
		t.Error("absent port reported as open")
	}
	// The protocol matters: a UDP hole does not carry the chat.
	if firewalldAllowsPort("9066/udp", 9066) {
		t.Error("9066/udp accepted for a TCP server")
	}
	if firewalldAllowsPort("", 9066) {
		t.Error("empty list reported as open")
	}
}

// 1.7.9 (PR #7): the rule no longer covers Public networks unless asked, and
// Windows often calls a home network Public. doctor must say so, because
// every other line it prints would read as a working firewall.
func TestReportNetworkProfile(t *testing.T) {
	const privOnly = "Rule Name: GobboNet-Web\r\nEnabled: Yes\r\nProfiles: Domain,Private\r\nLocalPort: 9066\r\n"
	const withPub = "Rule Name: GobboNet-Web\r\nEnabled: Yes\r\nProfiles: Domain,Private,Public\r\nLocalPort: 9066\r\n"
	cats := func(s string) func() (string, error) { return func() (string, error) { return s, nil } }
	cases := []struct {
		name, rule, cats string
		want             []string
		wantNone         bool
	}{
		{"public network, rule without public", privOnly, "Public\r\n", []string{"marked PUBLIC", "Private network", "setup-lan.bat /public"}, false},
		{"public network among several", privOnly, "Private\r\nPublic\r\n", []string{"marked PUBLIC"}, false},
		{"public network, rule with public", withPub, "Public\r\n", []string{"covers Public", "/public"}, false},
		{"private network", privOnly, "Private\r\n", nil, true},
		{"domain network", privOnly, "DomainAuthenticated\r\n", nil, true},
		{"no rule at all", "", "Public\r\n", nil, true},
	}
	for _, c := range cases {
		var b strings.Builder
		reportNetworkProfile(&b, c.rule, cats(c.cats))
		got := b.String()
		if c.wantNone && got != "" {
			t.Errorf("%s: want nothing, got %q", c.name, got)
		}
		for _, w := range c.want {
			if !strings.Contains(got, w) {
				t.Errorf("%s: missing %q in %q", c.name, w, got)
			}
		}
	}
}
