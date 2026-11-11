package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// The embedding server (1.8.0, #15): the small model that lets RAG match notes
// by meaning. Up to 1.7.9 a launcher script started it and nothing watched it;
// now this program does, unless embed_mode says otherwise.

// embed_mode values.
const (
	EmbedManaged  = "managed"
	EmbedExternal = "external"
	EmbedOff      = "off"
)

// DefaultEmbedCtx is the embedder's context, and its batch size.
const DefaultEmbedCtx = 2048

// GobboNet's own embedding model, its download address and its pin.
//
// The pin is the SHA-256 HuggingFace records for the file. It is written in
// three other places, each checked equal to this one by
// tests/test-embed-supervisor.py: launch.bat (EMBED_PIN_SHA256, the Windows
// first-run download) and installer-linux/gobbonet-setup.py with its
// linux-amd64 copy (the Linux setup wizard's download).
const (
	EmbedModelFile   = "nomic-embed-text-v1.5.Q8_0.gguf"
	EmbedModelURL    = "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5-GGUF/resolve/main/" + EmbedModelFile
	EmbedModelSHA256 = "3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7"
)

func (c *Config) normaliseEmbed() error {
	c.EmbedMode = strings.ToLower(strings.TrimSpace(c.EmbedMode))
	switch c.EmbedMode {
	case "":
		c.EmbedMode = EmbedManaged
	case EmbedManaged, EmbedExternal, EmbedOff:
	default:
		return fmt.Errorf(`embed_mode must be "managed", "external" or "off", not %q`, c.EmbedMode)
	}
	if c.EmbedCtx == 0 {
		c.EmbedCtx = DefaultEmbedCtx
	}
	if c.EmbedCtx < 256 || c.EmbedCtx > 32768 {
		return fmt.Errorf("embed_ctx must be between 256 and 32768, not %d", c.EmbedCtx)
	}
	if c.EmbedGPULayers < 0 || c.EmbedGPULayers > 999 {
		return fmt.Errorf("embed_gpu_layers must be between 0 (CPU only) and 999, not %d", c.EmbedGPULayers)
	}
	return nil
}

// EmbedModelPath is the embedding model a managed server starts, and the pin it
// must match ("" for a model of the user's own choosing, which is used as it
// is). found is false when there is no file to start.
//
// GobboNet's own model is looked for where the Linux setup wizard puts it,
// <data_dir>/embeddings, and then in model_dir, where launch.bat put it up to
// 1.7.9 -- so a Windows install does not download 146 MB again to move it.
// When it is in neither, path is the place it belongs.
func (c Config) EmbedModelPath() (path, pin string, found bool) {
	if c.EmbedModel != "" {
		st, err := os.Stat(c.EmbedModel)
		return c.EmbedModel, "", err == nil && st.Mode().IsRegular()
	}
	primary := filepath.Join(c.DataDir, "embeddings", EmbedModelFile)
	for _, p := range []string{primary, filepath.Join(c.ModelDir, EmbedModelFile)} {
		if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
			return p, EmbedModelSHA256, true
		}
	}
	return primary, EmbedModelSHA256, false
}
