package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/update"
	"github.com/ElodineOfficial/GobboNet/internal/version"
)

// RESTART NOW starts the new program as this one was started, minus what only
// made sense the first time: no second browser tab, no second setup.
func TestRestartArgs(t *testing.T) {
	cases := map[string]string{
		"--open --model qwen.gguf":            "--model qwen.gguf",
		"serve --config /x/config.toml":       "serve --config /x/config.toml",
		"launch":                              "launch --no-browser",
		"launch --setup":                      "launch --no-browser",
		"launch --no-browser --config a.toml": "launch --no-browser --config a.toml",
		"-open=true --port 9067":              "--port 9067",
		"--model open":                        "--model open",
		"":                                    "",
	}
	for in, want := range cases {
		got := strings.Join(restartArgs(strings.Fields(in)), " ")
		if got != want {
			t.Errorf("restartArgs(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRestartEnvDropsTheBannerMarker(t *testing.T) {
	t.Setenv("GOBBONET_BANNER_SHOWN", "1")
	for _, kv := range restartEnv() {
		if strings.HasPrefix(kv, "GOBBONET_BANNER_SHOWN=") {
			t.Fatal("the restarted program would skip its banner, which says which version it is")
		}
	}
}

// `gobbonet version --json` is what the updater reads from a new program
// before putting it in place.
func TestVersionJSON(t *testing.T) {
	var buf bytes.Buffer
	printVersionJSON(&buf)
	var s update.Stamp
	if err := json.Unmarshal(buf.Bytes(), &s); err != nil {
		t.Fatalf("%q: %v", buf.String(), err)
	}
	if s.Build != version.String() || s.GOOS != runtime.GOOS || s.GOARCH != runtime.GOARCH {
		t.Errorf("stamp = %+v", s)
	}
	if strings.Count(strings.TrimSpace(buf.String()), "\n") != 0 {
		t.Error("the stamp should be one line")
	}
}

// launch.bat waits on gobbonet.exe and says "GobboNet has stopped" when it
// returns. After RESTART NOW the new program is running in the same window,
// and the exit code is how the script knows to step aside instead.
func TestLaunchBatStepsAsideForARestart(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "launch.bat"))
	if err != nil {
		t.Fatal(err)
	}
	bat := strings.ReplaceAll(string(raw), "\r\n", "\n")
	run := strings.Index(bat, "\"!GN!\" !GN_OPEN! --model \"!GGUF_BASENAME!\"\n")
	stopped := strings.Index(bat, "GobboNet has stopped.")
	if run < 0 || stopped < run {
		t.Fatal("launch.bat's hand-over to gobbonet.exe was not found")
	}
	between := bat[run:stopped]
	if !strings.Contains(between, "set \"GN_RC=!errorlevel!\"") ||
		!strings.Contains(between, "if \"!GN_RC!\"==\""+strconv.Itoa(exitRestarted)+"\" exit 0") {
		t.Errorf("launch.bat does not step aside on exit code %d before saying GobboNet stopped:\n%s", exitRestarted, between)
	}
}
