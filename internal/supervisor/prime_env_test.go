//go:build linux

package supervisor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// gpu_prime_offload puts the fixed PRIME pair on the engine process, and only
// there (1.8.0, #72).
func TestPrimeOffloadReachesTheEngineOnly(t *testing.T) {
	dir := t.TempDir()
	dump := filepath.Join(dir, "env.txt")
	for _, prime := range []bool{false, true} {
		sup := newTestSupervisor(t, "#!/bin/sh\nenv > '"+dump+"'\nexit 1\n")
		sup.SetDevice("", prime)
		sup.Boot("model.gguf")
		raw, err := os.ReadFile(dump)
		if err != nil {
			t.Fatalf("the engine did not run: %v", err)
		}
		env := string(raw)
		has := strings.Contains(env, "__NV_PRIME_RENDER_OFFLOAD=1") && strings.Contains(env, "__VK_LAYER_NV_optimus=NVIDIA_only")
		if has != prime {
			t.Errorf("prime %v: engine environment has the pair = %v", prime, has)
		}
		if prime && !strings.Contains(env, "PATH=") {
			t.Error("the engine lost the rest of its environment")
		}
		os.Remove(dump)
	}
	if os.Getenv("__NV_PRIME_RENDER_OFFLOAD") != "" {
		t.Error("GobboNet's own process took the PRIME variables")
	}
}
