package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
)

// 1.8.0 (#15): gobbonet doctor says who runs the embedding server and whether
// its model is there and matches its pin.
func TestDoctorReportsTheEmbeddingServer(t *testing.T) {
	dir := t.TempDir()
	base := config.Default()
	base.DataDir = filepath.Join(dir, "data")
	base.ModelDir = filepath.Join(dir, "models")
	base.ServerExe = filepath.Join(dir, "llama-server")
	base.EmbedURL = "http://127.0.0.1:1" // nothing answers there

	run := func(c config.Config) string {
		var b bytes.Buffer
		reportEmbedding(&b, c)
		return b.String()
	}

	off := base
	off.EmbedMode = config.EmbedOff
	if got := run(off); !strings.Contains(got, `off (embed_mode = "off")`) {
		t.Errorf("off:\n%s", got)
	}

	noEngine := base
	noEngine.ServerExe = ""
	if got := run(noEngine); !strings.Contains(got, "external (managed, but there is no local engine") {
		t.Errorf("no engine:\n%s", got)
	}

	if got := run(base); !strings.Contains(got, "MISSING -- expected at "+filepath.Join(base.DataDir, "embeddings", config.EmbedModelFile)) ||
		!strings.Contains(got, "answering:   no") {
		t.Errorf("missing model:\n%s", got)
	}

	// 1.7's Windows location is found too, and a wrong file is named as such.
	os.MkdirAll(base.ModelDir, 0o755)
	os.WriteFile(filepath.Join(base.ModelDir, config.EmbedModelFile), []byte("not the real model"), 0o600)
	if got := run(base); !strings.Contains(got, "model:       "+filepath.Join(base.ModelDir, config.EmbedModelFile)) ||
		!strings.Contains(got, "DOES NOT MATCH its pin (expected 3e24342164b3") {
		t.Errorf("mismatched model:\n%s", got)
	}

	own := base
	own.EmbedModel = filepath.Join(dir, "mine.gguf")
	os.WriteFile(own.EmbedModel, []byte("x"), 0o600)
	if got := run(own); !strings.Contains(got, "not checked (a model of your own") {
		t.Errorf("own model:\n%s", got)
	}
}
