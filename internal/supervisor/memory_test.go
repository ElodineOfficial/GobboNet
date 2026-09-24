package supervisor

import (
	"github.com/ElodineOfficial/GobboNet/internal/models"
	"strings"
	"testing"
)

func TestAutoPlacementPreservesContextAndPrecision(t *testing.T) {
	s, err := New(Options{LLMURL: "http://127.0.0.1:1", GPUReserveMiB: 1024, Tuning: Tuning{CtxSize: 32768, GPULayers: -1, KVCacheType: "f16"}})
	if err != nil {
		t.Fatal(err)
	}
	args := s.BuildArgs(models.Record{}, "model.gguf")
	values := map[string]string{}
	for i := 0; i+1 < len(args); i++ {
		if strings.HasPrefix(args[i], "--") {
			values[args[i]] = args[i+1]
		}
	}
	for k, want := range map[string]string{"--n-gpu-layers": "auto", "--fit": "on", "--fit-target": "1024", "--fit-ctx": "32768", "--ctx-size": "32768", "--cache-type-k": "f16", "--cache-type-v": "f16", "--parallel": "1"} {
		if values[k] != want {
			t.Errorf("%s=%q want %q", k, values[k], want)
		}
	}
	for _, n := range []int{0, 20, 99} {
		s.SetTuning(Tuning{CtxSize: 32768, GPULayers: n, KVCacheType: "f16"})
		args = s.BuildArgs(models.Record{}, "model.gguf")
		if strings.Contains(strings.Join(args, " "), "--fit") {
			t.Fatalf("auto flags override explicit layers %d", n)
		}
	}
}

func TestMemoryReportSeparatesBuffersAndDeduplicates(t *testing.T) {
	s := feed(realVulkanLoad)
	lines := []string{"llama_kv_cache_unified: Vulkan0 KV buffer size = 2048.00 MiB", "llama_context: Vulkan0 compute buffer size = 512.00 MiB", "llama_context: Vulkan_Host compute buffer size = 128.00 MiB", "llama_context: n_ctx_seq = 32768"}
	for _, line := range lines {
		s.Feed(line)
		s.Feed(line)
	}
	got := s.MemoryLine()
	for _, want := range []string{"KV 2.0 GB", "compute 512 MB", "subtotal 5.4 GB", "not total dedicated VRAM", "32,768"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q: %s", want, got)
		}
	}
	if strings.Contains(got, "640 MB") {
		t.Fatal("host buffer counted as GPU")
	}
	s.Feed("llama_context: Vulkan0 compute buffer size = 256.00 MiB")
	if !strings.Contains(s.MemoryLine(), "compute 256 MB") {
		t.Fatal("did not replace resized allocation")
	}
}
