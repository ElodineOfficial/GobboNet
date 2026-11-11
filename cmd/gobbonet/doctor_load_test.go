package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// doctor's LAST MODEL LOAD section (1.8.0, #67).
func TestDoctorSaysWhyTheLastLoadFailed(t *testing.T) {
	log := filepath.Join(t.TempDir(), "llama-server.log")
	body := "\n=== GobboNet: starting llama-server for old.gguf at 2026-11-01T10:00:00Z ===\n" +
		"gguf_init_from_file: failed to open GGUF file '/m/old.gguf'\n" +
		"\n=== GobboNet: starting llama-server for big.gguf at 2026-11-03T10:00:00Z ===\n" +
		"alloc_tensor_range: failed to allocate Vulkan0 buffer of size 13421772800\n" +
		"llama_model_load_from_file_impl: failed to load model\n" +
		"main: exiting due to model loading error\n"
	os.WriteFile(log, []byte(body), 0o600)
	var out bytes.Buffer
	reportLastLoad(&out, log)
	got := out.String()
	for _, want := range []string{"model:       big.gguf", "FAILED -- Not enough GPU or system memory",
		"details:     alloc_tensor_range: failed to allocate Vulkan0 buffer", "whole log:   " + log} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "old.gguf") || strings.Contains(got, "exiting due to") {
		t.Errorf("reported an older run or the sign-off:\n%s", got)
	}
}

func TestDoctorSaysTheLastLoadWorked(t *testing.T) {
	log := filepath.Join(t.TempDir(), "llama-server.log")
	os.WriteFile(log, []byte("\n=== GobboNet: starting llama-server for a.gguf at x ===\n"+
		"gguf_init_from_file: failed to open GGUF file '/m/a.gguf'\n"+
		"\n=== GobboNet: starting llama-server for b.gguf at y ===\n"+
		"main: server is listening on http://127.0.0.1:11437 - starting the main loop\n"), 0o600)
	var out bytes.Buffer
	reportLastLoad(&out, log)
	if !strings.Contains(out.String(), "model:       b.gguf") || !strings.Contains(out.String(), "result:      loaded") {
		t.Errorf("a later successful load must win over an earlier failure:\n%s", out.String())
	}
}

func TestDoctorWithNoLogOrAnOldOne(t *testing.T) {
	var out bytes.Buffer
	reportLastLoad(&out, filepath.Join(t.TempDir(), "missing.log"))
	if !strings.Contains(out.String(), "no engine log yet") {
		t.Errorf("no log:\n%s", out.String())
	}
	log := filepath.Join(t.TempDir(), "llama-server.log")
	os.WriteFile(log, []byte("llama_model_load: error loading model: error loading model architecture: unknown model architecture: 'x'\n"), 0o600)
	out.Reset()
	reportLastLoad(&out, log)
	if !strings.Contains(out.String(), "needs a newer engine") || !strings.Contains(out.String(), "from before 1.8.0") {
		t.Errorf("an unmarked log is still read, and says it may be old:\n%s", out.String())
	}
}
