package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 1.8.0 (#15): the embedding server's keys.
func TestEmbedKeysDefaultAndValidate(t *testing.T) {
	c, err := Load(writeConfig(t, ""))
	if err != nil {
		t.Fatal(err)
	}
	if c.EmbedMode != EmbedManaged || c.EmbedCtx != DefaultEmbedCtx || c.EmbedGPULayers != 0 || c.EmbedModel != "" {
		t.Errorf("defaults: mode=%q ctx=%d gpu=%d model=%q", c.EmbedMode, c.EmbedCtx, c.EmbedGPULayers, c.EmbedModel)
	}
	if c, err := Load(writeConfig(t, "embed_mode = \"OFF\"\n")); err != nil || c.EmbedMode != EmbedOff {
		t.Errorf("case is ignored: %q %v", c.EmbedMode, err)
	}
	for body, want := range map[string]string{
		"embed_mode = \"sometimes\"\n": `embed_mode must be "managed", "external" or "off"`,
		"embed_ctx = 100\n":            "embed_ctx must be between 256 and 32768",
		"embed_gpu_layers = -1\n":      "embed_gpu_layers must be between 0",
	} {
		if _, err := Load(writeConfig(t, body)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: got %v, want %q", body, err, want)
		}
	}
}

func TestEmbedModelPathLooksWhereEachPlatformPutIt(t *testing.T) {
	dir := t.TempDir()
	c := Default()
	c.DataDir, c.ModelDir = filepath.Join(dir, "data"), filepath.Join(dir, "models")
	primary := filepath.Join(c.DataDir, "embeddings", EmbedModelFile)
	legacy := filepath.Join(c.ModelDir, EmbedModelFile)

	if path, pin, found := c.EmbedModelPath(); path != primary || pin != EmbedModelSHA256 || found {
		t.Errorf("none yet: %s %s %v", path, pin, found)
	}
	os.MkdirAll(c.ModelDir, 0o755)
	os.WriteFile(legacy, []byte("x"), 0o600)
	if path, _, found := c.EmbedModelPath(); path != legacy || !found {
		t.Errorf("1.7's Windows place, model_dir: %s %v", path, found)
	}
	os.MkdirAll(filepath.Dir(primary), 0o755)
	os.WriteFile(primary, []byte("x"), 0o600)
	if path, _, found := c.EmbedModelPath(); path != primary || !found {
		t.Errorf("the data folder wins: %s %v", path, found)
	}
	c.EmbedModel = filepath.Join(dir, "mine.gguf")
	if path, pin, found := c.EmbedModelPath(); path != c.EmbedModel || pin != "" || found {
		t.Errorf("a model of your own, not there: %s %q %v", path, pin, found)
	}
}
