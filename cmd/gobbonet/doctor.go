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

	"github.com/jmccardle/gobbonet/internal/config"
	"github.com/jmccardle/gobbonet/internal/version"
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
	case sidecar == "":
		// Only when os.Executable fails, which is close to never.
	case recorded == 0:
		fmt.Printf("  .gobbonet-port: not written yet (%s)\n", sidecar)
		fmt.Println("               Written when the server starts. setup-lan.bat reads it.")
	case recorded != cfg.ListenPort:
		fmt.Printf("  .gobbonet-port: %d  -- DISAGREES with listen_port %d\n", recorded, cfg.ListenPort)
		fmt.Printf("               %s\n", sidecar)
		fmt.Println("               The firewall rule and URL reservation were made for the")
		fmt.Println("               first, but the server binds the second. Start the server")
		fmt.Println("               once to rewrite it, then re-run setup-lan.bat.")
	default:
		fmt.Printf("  .gobbonet-port: %d (agrees)\n", recorded)
	}

	reportPortOwner(cfg.ListenHost, cfg.ListenPort)
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
func reportPortOwner(host string, port int) {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	ln, err := net.Listen("tcp", addr)
	if err == nil {
		ln.Close()
		fmt.Println("  in use:      no -- the port is free to bind")
		return
	}
	fmt.Printf("  in use:      YES -- %v\n", err)

	// Something holds it. Ask whether it is us. This is the same identity
	// question the Linux launcher asks, and for the same reason: "something
	// answered" is not "my service is running".
	status, body, err := probeHealth(port)
	switch {
	case err != nil:
		fmt.Printf("  identity:    holds the port but did not answer HTTP (%v)\n", err)
		fmt.Println("               Not GobboNet. Stop it, or pick another port:")
		fmt.Printf("                 gobbonet config set listen_port %d\n", port+1)
	case status == 200 && strings.Contains(body, `"status"`):
		fmt.Println("  identity:    GobboNet (200, auth disabled) -- already running")
	case status == 401 && strings.Contains(body, `"login"`):
		fmt.Println("  identity:    GobboNet (401 from our own auth) -- already running")
	case status == 503:
		fmt.Println("  identity:    503 with no server behind it.")
		if runtime.GOOS == "windows" {
			fmt.Println("               This is the HTTP.SYS signature: a URL reservation")
			fmt.Println("               exists for this port but nothing is listening on it.")
			fmt.Println("               See the URL RESERVATION section below.")
		}
	default:
		fmt.Printf("  identity:    NOT GobboNet -- something else answered %d\n", status)
		fmt.Println("               Stop it, or pick another port:")
		fmt.Printf("                 gobbonet config set listen_port %d\n", port+1)
	}
}

// probeHealth fetches /health-fileserver and returns the status and body.
//
// A 401 is a result, not a failure: /health-fileserver sits behind the auth
// gate and require_auth defaults to true, so on a normal install the 401 is
// what proves the server is ours. Accept is set explicitly because the server
// serves the login PAGE when it sees text/html.
func probeHealth(port int) (int, string, error) {
	url := fmt.Sprintf("http://127.0.0.1:%d/health-fileserver", port)
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
