package main

import (
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/server"
	"github.com/ElodineOfficial/GobboNet/internal/version"
)

// `gobbonet doctor` prints where everything is and who owns what.
//
// This exists because of a support report that took four escalating remedies
// and still failed. The user uninstalled, deleted the leftovers, wiped the
// folder, and reinstalled to the default path, and the 503 survived all of it —
// because the thing causing it was a URL reservation in the kernel and a
// config file in %USERPROFILE%\.config, and no uninstaller touched either.
// Every remedy he tried was a guess, because nothing on the machine would tell
// him where to look.
//
// So this is a read-only report, and it goes out of its way to name FULL PATHS
// and exact commands. It changes nothing: someone running a diagnostic on a
// broken install must not have to wonder whether the diagnostic broke it
// further.
func cmdDoctor(argv []string) error {
	fs := flag.NewFlagSet("gobbonet doctor", flag.ContinueOnError)
	configPath := stringFlag(fs, "config", "path to config.toml")
	if err := fs.Parse(argv); err != nil {
		return err
	}

	fmt.Printf("GobboNet doctor -- %s on %s/%s\n\n", version.Full(), runtime.GOOS, runtime.GOARCH)

	// --- Config -------------------------------------------------------------
	// Printed before it is loaded, and printed even when loading fails. "Which
	// file is it even reading" is the first question, and a parse error is
	// exactly when you most need the answer.
	path, explicit := config.Discover(*configPath)
	fmt.Println("CONFIG")
	fmt.Printf("  path:        %s\n", path)
	if explicit {
		fmt.Println("               (set explicitly by --config or $GOBBONET_CONFIG)")
	}
	if _, err := os.Stat(path); err != nil {
		fmt.Println("  exists:      NO -- run `gobbonet setup`, or start the server to write a default")
		fmt.Printf("\n  Nothing else can be checked without it.\n")
		return nil
	}
	fmt.Println("  exists:      yes")
	fmt.Printf("  config dir:  %s\n", config.ConfigDir())
	fmt.Printf("  data dir:    %s\n", config.DataDir())
	fmt.Println("               Neither uninstaller removes these. `gobbonet uninstall`")
	fmt.Println("               is the command that clears them.")

	cfg, err := config.Load(path)
	if err != nil {
		fmt.Printf("\n  [ERROR] this file did not parse: %v\n", err)
		return nil
	}
	fmt.Println()

	// --- Engine -------------------------------------------------------------
	fmt.Println("ENGINE")
	switch {
	case cfg.ServerExe == "":
		fmt.Println("  server_exe:  (empty) -- remote mode; this process supervises nothing")
		fmt.Printf("  llm_url:     %s\n", cfg.LLMURL)
	default:
		fmt.Printf("  server_exe:  %s\n", cfg.ServerExe)
		if st, err := os.Stat(cfg.ServerExe); err == nil && !st.IsDir() {
			fmt.Println("  status:      found")
		} else {
			fmt.Println("  status:      MISSING -- this is a fatal error at startup")
			probe := cfg
			if from, healed := probe.HealServerExe(); healed {
				fmt.Printf("  repairable:  yes -- %s\n", probe.ServerExe)
				fmt.Println("               Starting the server will adopt that and rewrite the config.")
				_ = from
			} else {
				fmt.Println("  repairable:  no -- no llama-server found beside this binary")
				fmt.Println("               Fix the path, or clear it to run in remote mode:")
				fmt.Println("                 gobbonet config set server_exe \"\"")
			}
		}
		fmt.Printf("  llm_url:     %s\n", cfg.LLMURL)
	}
	fmt.Println()

	// --- Ports --------------------------------------------------------------
	fmt.Println("WEB PORT")
	fmt.Printf("  listen:      %s:%d\n", cfg.ListenHost, cfg.ListenPort)

	// The sidecar is the file setup-lan.bat reads to decide which port to open
	// in the firewall and reserve with HTTP.SYS. A disagreement here is the
	// exact shape of "the firewall rule is on a port nothing listens on".
	sidecar := config.PortFilePath()
	switch recorded := config.ReadPortFile(); {
	case !config.PortFileSupported():
		// Not a fault, and not worth a path the user could go looking for.
		// The sidecar's only readers are the Windows LAN scripts (NEW-3).
		fmt.Println("  .gobbonet-port: not used on this platform")
		fmt.Println("               Only setup-lan.bat and launch.bat read it, and both are")
		fmt.Println("               Windows-only. The port here comes from listen_port above.")
	case sidecar == "":
		// Only when os.Executable fails, which is close to never.
	case recorded == 0:
		// "Not written yet" is a claim about time, and it used to be printed
		// for a directory the file could never be written to (NEW-2). That is
		// worse than saying nothing: someone chasing a LAN problem is told the
		// file is merely pending and goes to look somewhere else. Ask whether
		// the write can actually happen before implying it is about to.
		if ok, err := config.PortFileWritable(); ok {
			fmt.Printf("  .gobbonet-port: not written yet (%s)\n", sidecar)
			fmt.Println("               Written when the server starts. setup-lan.bat reads it.")
		} else {
			fmt.Printf("  .gobbonet-port: CANNOT BE WRITTEN (%s)\n", sidecar)
			if err != nil {
				fmt.Printf("               %v\n", err)
			}
			fmt.Println("               This will not fix itself by starting the server. Until")
			fmt.Println("               it can be written, setup-lan.bat cannot see which port")
			fmt.Println("               the server bound and falls back to its own default.")
		}
	case recorded != cfg.ListenPort:
		fmt.Printf("  .gobbonet-port: %d  -- DISAGREES with listen_port %d\n", recorded, cfg.ListenPort)
		fmt.Printf("               %s\n", sidecar)
		fmt.Println("               The firewall rule and URL reservation were made for the")
		fmt.Println("               first, but the server binds the second. Start the server")
		fmt.Println("               once to rewrite it, then re-run setup-lan.bat.")
	default:
		fmt.Printf("  .gobbonet-port: %d (agrees)\n", recorded)
	}

	reportPortOwner(os.Stdout, cfg.ListenHost, cfg.ListenPort)
	fmt.Println()

	// --- LAN access ---------------------------------------------------------
	// This section is what a phone report should be triaged against, and until
	// now nothing printed it. doctor reported the URL reservation, which the Go
	// server does not use at all, and said nothing about the firewall rule,
	// which is the only thing standing between a bound socket and the phone.
	// That is backwards, and it sent at least one report down the URL-ACL path
	// for a problem that was never there.
	fmt.Println("LAN ACCESS")
	reportLANAddrs(os.Stdout, cfg)
	switch runtime.GOOS {
	case "windows":
		reportFirewall(os.Stdout, cfg.ListenPort)
	case "linux":
		reportLinuxFirewall(os.Stdout, cfg.ListenPort)
	}
	fmt.Println()

	// --- Windows: the URL reservation --------------------------------------
	if runtime.GOOS == "windows" {
		fmt.Println("URL RESERVATION (HTTP.SYS)")
		reportURLACL(cfg.ListenPort)
		fmt.Println()
	}

	fmt.Println("LOGS")
	fmt.Printf("  llama-server:  %s\n", cfg.LogFile())
	fmt.Printf("  startup fail:  %s\n", startupLogPath())
	return nil
}

// reportPortOwner answers "is anything on this port, and is it us".
//
// It asks by binding and by asking, not by shelling out to netstat, ss or
// lsof: none of those is guaranteed to exist, all of them format differently
// per platform and locale, and the question they answer ("which pid") is less
// useful here than the one this answers ("is the thing on my port mine").
func reportPortOwner(w io.Writer, host string, port int) {
	// Ask who is there BEFORE asking whether the port is free, because those
	// are different questions and they come apart in practice (NEW-4). A
	// triage run had doctor print "the port is free to bind" while GobboNet
	// was serving on that exact port: under WSL2's mirrored networking the
	// bind conflict the probe relies on is not always reported to the guest.
	//
	// Whatever the local reason, a bind probe can only ever answer "could I
	// bind this address right now". Leading with it means a quirk in that one
	// answer takes the identity check down with it, and the section that
	// exists to diagnose a port conflict confidently reports no conflict.
	//
	// An HTTP answer cannot be wrong in that direction: if something replies,
	// something is listening. So the reply decides, and the bind probe is
	// demoted to what it is actually good for — telling "nothing is there"
	// apart from "something is there that does not speak HTTP".
	status, body, probeErr := probeHealth(probeHost(host), port)
	answered := probeErr == nil

	bindErr := bindProbe(net.JoinHostPort(host, strconv.Itoa(port)))

	switch {
	case bindErr != nil:
		fmt.Fprintf(w, "  in use:      YES -- %v\n", bindErr)
	case answered:
		fmt.Fprintln(w, "  in use:      YES -- something answered HTTP on this port")
		fmt.Fprintln(w, "               The bind probe disagreed and said the port was free.")
		fmt.Fprintln(w, "               Trusting the answer: a reply means a listener. This")
		fmt.Fprintln(w, "               happens under WSL2 mirrored networking.")
	default:
		fmt.Fprintln(w, "  in use:      no -- the port is free to bind")
		return
	}

	// Something is there. Ask whether it is us. This is the same identity
	// question the Linux launcher asks, and for the same reason: "something
	// answered" is not "my service is running".
	switch {
	case probeErr != nil:
		fmt.Fprintf(w, "  identity:    holds the port but did not answer HTTP (%v)\n", probeErr)
		fmt.Fprintln(w, "               Not GobboNet. Stop it, or pick another port:")
		fmt.Fprintf(w, "                 gobbonet config set listen_port %d\n", port+1)
	case status == 200 && strings.Contains(body, `"status"`):
		fmt.Fprintln(w, "  identity:    GobboNet (200, auth disabled) -- already running")
	case status == 401 && strings.Contains(body, `"login"`):
		fmt.Fprintln(w, "  identity:    GobboNet (401 from our own auth) -- already running")
	case status == 503:
		fmt.Fprintln(w, "  identity:    503 with no server behind it.")
		if runtime.GOOS == "windows" {
			fmt.Fprintln(w, "               This is the HTTP.SYS signature: a URL reservation")
			fmt.Fprintln(w, "               exists for this port but nothing is listening on it.")
			fmt.Fprintln(w, "               See the URL RESERVATION section below.")
		}
	default:
		fmt.Fprintf(w, "  identity:    NOT GobboNet -- something else answered %d\n", status)
		fmt.Fprintln(w, "               Stop it, or pick another port:")
		fmt.Fprintf(w, "                 gobbonet config set listen_port %d\n", port+1)
	}
}

// bindProbe reports whether addr could be bound right now, returning nil when
// it could. A variable so a test can reproduce the disagreement NEW-4 is
// about — a bind that reports success while a server is answering on the port
// — which is otherwise not something a test can arrange on a working stack.
var bindProbe = func(addr string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return err
	}
	return ln.Close()
}

// probeHost turns a bind address into one that can be connected to.
//
// 0.0.0.0 and :: are answers to "what should I accept on", not addresses a
// client can dial; connecting to them is undefined and on some stacks simply
// fails. Loopback is the right dial target for a wildcard bind because the
// wildcard includes it. A specific listen_host is dialled as written, which is
// what makes the check work for an install pinned to one LAN address.
func probeHost(host string) string {
	switch host {
	case "", "0.0.0.0", "::", "[::]":
		return "127.0.0.1"
	}
	return host
}

// probeHealth fetches /health-fileserver and returns the status and body.
//
// A 401 is a result, not a failure: /health-fileserver sits behind the auth
// gate and require_auth defaults to true, so on a normal install the 401 is
// what proves the server is ours. Accept is set explicitly because the server
// serves the login PAGE when it sees text/html.
func probeHealth(host string, port int) (int, string, error) {
	url := fmt.Sprintf("http://%s/health-fileserver", net.JoinHostPort(host, strconv.Itoa(port)))
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Accept", "application/json")
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
	return resp.StatusCode, string(body), nil
}

// reportLANAddrs lists every address a phone could try, which is the list the
// banner now prints and the one thing a "it wouldn't connect from my phone"
// report needs attached to it.
//
// These are candidates for the CONFIGURED host. A running server may have
// fallen back to loopback, in which case none of them apply; /health-fileserver
// on the live process is what knows, and it is named here rather than guessed
// at from another process's config.
func reportLANAddrs(w io.Writer, cfg config.Config) {
	if isLoopbackConfigured(cfg.ListenHost) {
		fmt.Fprintf(w, "  listen_host: %s -- this machine only, by configuration.\n", cfg.ListenHost)
		fmt.Fprintln(w, "               No phone can reach this. To allow it:")
		fmt.Fprintln(w, "                 gobbonet config set listen_host 0.0.0.0")
		return
	}

	addrs := server.LANAddrsFor(cfg.ListenHost)
	if len(addrs) == 0 {
		fmt.Fprintln(w, "  addresses:   NONE -- no usable address on any adapter.")
		fmt.Fprintln(w, "               Every adapter is down, loopback, or virtual. If this")
		fmt.Fprintln(w, "               machine is on Wi-Fi, it did not get a DHCP lease.")
		return
	}
	fmt.Fprintln(w, "  addresses a phone could try, best first:")
	for _, a := range addrs {
		note := a.Iface
		if a.Kind != server.LANPhysical {
			note += " -- " + a.Kind.String() + ", unlikely"
		}
		fmt.Fprintf(w, "    %-28s %s\n", a.URL(cfg.ListenPort), "("+note+")")
	}
	if cfg.ListenHost == "0.0.0.0" {
		// Worth saying out loud: 0.0.0.0 is the v4 wildcard and binds v4 only.
		// A phone that resolved a .local name to an AAAA record gets nothing,
		// and the symptom is identical to a firewall block.
		fmt.Fprintln(w, "               listen_host is 0.0.0.0, which accepts IPv4 only. If a")
		fmt.Fprintln(w, "               .local name fails while the numeric address works, that")
		fmt.Fprintln(w, "               is why. `gobbonet config set listen_host \"::\"` accepts both.")
	}
}

func isLoopbackConfigured(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// reportFirewall answers the question the whole LAN path actually turns on, and
// which nothing in this tree asked before: is there a rule letting the phone in,
// is it on the right port, and is anything blocking us anyway.
//
// The block-rule scan is the important half. Windows writes program-scoped
// Block rules when the "Allow access?" prompt is dismissed -- and the install is
// deliberately non-admin, so that prompt appears at first launch with no way to
// answer it correctly. Block beats Allow in Windows Firewall, so those rules
// override the port rule setup-lan.bat adds, and setup-lan.bat still reports
// [OK] for everything it did. Nothing on the machine would say otherwise.
func reportFirewall(w io.Writer, port int) {
	out, err := exec.Command("netsh", "advfirewall", "firewall", "show",
		"rule", "name=Gemma4-Web").CombinedOutput()
	switch {
	case err != nil && len(out) == 0:
		fmt.Fprintf(w, "  firewall:    could not run netsh: %v\n", err)
	case !strings.Contains(string(out), strconv.Itoa(port)):
		fmt.Fprintln(w, "  firewall:    NO RULE for this port.")
		fmt.Fprintln(w, "               Either setup-lan.bat was never run, or it ran before")
		fmt.Fprintln(w, "               the port was settled and opened a different one. Re-run")
		fmt.Fprintln(w, "               it as Administrator now that listen_port is known:")
		fmt.Fprintln(w, "                 right-click setup-lan.bat -> Run as administrator")
	default:
		fmt.Fprintf(w, "  firewall:    rule Gemma4-Web present for port %d\n", port)
		// Present is not sufficient. The rule is scoped to LocalSubnet, which
		// is computed per-interface, so a phone on a mesh node or guest SSID
		// with its own DHCP scope is off-subnet and dropped by a rule that
		// looks correct in every listing.
		fmt.Fprintln(w, "               Scoped to LocalSubnet. A phone on a guest network, a")
		fmt.Fprintln(w, "               mesh node with its own DHCP scope, or a different band")
		fmt.Fprintln(w, "               on a split-SSID router is off-subnet and still blocked.")
	}

	blocks, err := exec.Command("netsh", "advfirewall", "firewall", "show",
		"rule", "name=all", "dir=in").CombinedOutput()
	if err != nil && len(blocks) == 0 {
		return
	}
	if n := countBlockedGobbonetRules(string(blocks)); n > 0 {
		fmt.Fprintf(w, "  [!] BLOCK RULES: %d inbound rule(s) name gobbonet and block it.\n", n)
		fmt.Fprintln(w, "               Windows writes these when the \"Allow access?\" prompt is")
		fmt.Fprintln(w, "               dismissed at first launch. A Block rule beats the Allow")
		fmt.Fprintln(w, "               rule above, so the firewall looks configured and the")
		fmt.Fprintln(w, "               phone is still refused. Remove them (as Administrator):")
		fmt.Fprintln(w, "                 netsh advfirewall firewall delete rule name=all program=\"<path>\\gobbonet.exe\"")
	}
}

// reportLinuxFirewall is the Linux half of the same question.
//
// The .deb ships no firewall handling of any kind -- postinst deliberately
// touches nothing outside the package, which is right -- so a Linux user with
// ufw enabled gets the identical symptom to the Windows one: the server binds
// 0.0.0.0, the banner prints an address, and the phone is refused by something
// no part of GobboNet ever mentions. Ubuntu's ufw denies inbound by default the
// moment it is switched on.
//
// This only ever REPORTS. doctor changes nothing by contract, and a diagnostic
// that quietly punched a hole in someone's firewall would be a far worse
// surprise than the one it fixed. The exact command is printed instead, so the
// decision stays with the person whose machine it is.
func reportLinuxFirewall(w io.Writer, port int) {
	if conf, err := os.ReadFile("/etc/ufw/ufw.conf"); err == nil && ufwEnabled(string(conf)) {
		// `ufw status` needs root and doctor does not run as root, so a
		// non-empty read is a bonus rather than the plan. Absent it we report
		// what we know -- ufw is on -- rather than guessing at the rules.
		status, _ := exec.Command("ufw", "status").CombinedOutput()
		if len(status) > 0 && ufwAllowsPort(string(status), port) {
			fmt.Fprintf(w, "  firewall:    ufw is active and allows %d/tcp\n", port)
			return
		}
		fmt.Fprintln(w, "  firewall:    ufw is ACTIVE.")
		if len(status) == 0 {
			fmt.Fprintln(w, "               (Rules need root to list, so this cannot say whether")
			fmt.Fprintln(w, "               the port is already open. Check with: sudo ufw status)")
		} else {
			fmt.Fprintf(w, "               No rule allows %d/tcp, so phones are refused.\n", port)
		}
		fmt.Fprintln(w, "               To allow it from your local network only:")
		fmt.Fprintf(w, "                 sudo ufw allow from 192.168.0.0/16 to any port %d proto tcp\n", port)
		fmt.Fprintln(w, "               Substitute your own subnet. Do not open it to any address:")
		fmt.Fprintln(w, "               the chat is password-protected but not encrypted.")
		return
	}

	state, err := exec.Command("firewall-cmd", "--state").CombinedOutput()
	if err == nil && strings.Contains(string(state), "running") {
		ports, _ := exec.Command("firewall-cmd", "--list-ports").CombinedOutput()
		if firewalldAllowsPort(string(ports), port) {
			fmt.Fprintf(w, "  firewall:    firewalld is running and allows %d/tcp\n", port)
			return
		}
		fmt.Fprintln(w, "  firewall:    firewalld is RUNNING and does not list this port.")
		fmt.Fprintln(w, "               To allow it in the zone this machine's LAN sits in:")
		fmt.Fprintf(w, "                 sudo firewall-cmd --permanent --add-port=%d/tcp\n", port)
		fmt.Fprintln(w, "                 sudo firewall-cmd --reload")
		return
	}

	// Neither found. nftables and raw iptables need root even to read, so
	// saying "no firewall" here would be a claim we cannot support -- and it is
	// the claim that would send someone away from the real cause.
	fmt.Fprintln(w, "  firewall:    no ufw or firewalld found. If the phone still cannot")
	fmt.Fprintln(w, "               connect, check nftables/iptables: sudo nft list ruleset")
}

// ufwEnabled parses /etc/ufw/ufw.conf, which is world-readable -- unlike
// `ufw status`, which needs root. Being able to answer without privilege is the
// point: doctor runs as the user, and a check that only works under sudo is a
// check most people never run.
func ufwEnabled(conf string) bool {
	for _, line := range strings.Split(conf, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			if strings.EqualFold(strings.TrimSpace(k), "ENABLED") {
				return strings.EqualFold(strings.TrimSpace(v), "yes")
			}
		}
	}
	return false
}

// ufwAllowsPort reads the `ufw status` table.
//
// Field-parsed rather than substring-matched, because a substring search for
// "9066" also matches 19066 and 90660 and would report an open port that is
// nothing of the kind.
func ufwAllowsPort(status string, port int) bool {
	want := strconv.Itoa(port)
	for _, line := range strings.Split(status, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 || !strings.EqualFold(fields[1], "ALLOW") {
			continue
		}
		spec, _, _ := strings.Cut(fields[0], "/")
		if spec == want {
			return true
		}
	}
	return false
}

// firewalldAllowsPort reads `firewall-cmd --list-ports`, which is a single
// space-separated line of port/proto pairs.
func firewalldAllowsPort(list string, port int) bool {
	want := strconv.Itoa(port) + "/tcp"
	for _, f := range strings.Fields(list) {
		if f == want {
			return true
		}
	}
	return false
}

// countBlockedGobbonetRules counts inbound Block rules naming our binary.
//
// netsh prints one blank-line-separated stanza per rule and translates its
// FIELD LABELS but not the values, so the parse keys on the values: the program
// path, and the English-invariant "Block" action keyword. Split out from
// reportFirewall so it can be tested without netsh.
func countBlockedGobbonetRules(out string) int {
	n := 0
	for _, stanza := range strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n\n") {
		low := strings.ToLower(stanza)
		if strings.Contains(low, "gobbonet.exe") && strings.Contains(low, "block") {
			n++
		}
	}
	return n
}

// reportURLACL asks netsh what is reserved for this port.
//
// netsh ships with Windows, so this adds nothing to install. The match is on
// the URL rather than on a header, because netsh translates its headers and
// matching an English one silently reports "no reservation" on a German or
// French machine — setup-lan.bat documents having been bitten by exactly that.
func reportURLACL(port int) {
	url := fmt.Sprintf("http://+:%d/", port)
	out, err := exec.Command("netsh", "http", "show", "urlacl", "url="+url).CombinedOutput()
	if err != nil {
		fmt.Printf("  could not run netsh: %v\n", err)
		return
	}
	// netsh exits 0 whether or not it found anything, so the exit code says
	// nothing and the output has to be read.
	if strings.Contains(string(out), fmt.Sprintf(":%d/", port)) {
		fmt.Printf("  reserved:    YES for %s\n", url)
		fmt.Println("               Made by setup-lan.bat. Harmless while GobboNet is")
		fmt.Println("               running; if nothing is listening, HTTP.SYS answers")
		fmt.Println("               this port with 503 by itself -- which looks exactly")
		fmt.Println("               like a broken install and survives reinstalling.")
		fmt.Println("               Remove it (as Administrator) with:")
		fmt.Printf("                 netsh http delete urlacl url=%s\n", url)
		fmt.Println("               or run teardown-lan.bat from the install folder.")
	} else {
		fmt.Printf("  reserved:    no reservation for %s\n", url)
	}
}

// startupLogPath is where a fatal startup error is recorded.
//
// It sits next to the config rather than in the data directory because a config
// error is the failure most likely to be fatal, and the config directory is the
// one place the user is already being pointed at.
func startupLogPath() string {
	return filepath.Join(config.ConfigDir(), "startup-error.log")
}
