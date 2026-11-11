package supervisor

import (
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/models"
)

// gpu_device becomes --device (1.8.0, #72).
func TestBuildArgsCarriesTheChosenDevice(t *testing.T) {
	s, _, modelDir := swapFixture(t)
	rec := models.Record{File: "real.gguf"}
	args := strings.Join(s.BuildArgs(rec, modelDir+"/real.gguf"), " ")
	if strings.Contains(args, "--device") {
		t.Errorf("automatic still passes --device: %s", args)
	}
	s.SetDevice("Vulkan1", false)
	args = strings.Join(s.BuildArgs(rec, modelDir+"/real.gguf"), " ")
	if !strings.Contains(args, "--device Vulkan1") {
		t.Errorf("gpu_device Vulkan1 is not --device Vulkan1: %s", args)
	}
	s.SetDevice("none", false)
	if args = strings.Join(s.BuildArgs(rec, modelDir+"/real.gguf"), " "); !strings.Contains(args, "--device none") {
		t.Errorf("gpu_device none is not --device none: %s", args)
	}
	if dev, prime := s.Device(); dev != "none" || prime {
		t.Errorf("Device() = %q, %v", dev, prime)
	}
	n, err := New(Options{ModelDir: modelDir, LLMURL: "http://127.0.0.1:1", Device: "CUDA0", PrimeOffload: true})
	if err != nil {
		t.Fatal(err)
	}
	if dev, prime := n.Device(); dev != "CUDA0" || !prime {
		t.Errorf("Options did not seed the device: %q, %v", dev, prime)
	}
}

func TestLastLoadSummaryReadsTheLastRun(t *testing.T) {
	log := logRunMarker + "a.gguf at x ===\n" +
		"llama_prepare_model_devices: using device Vulkan0 (Intel(R) HD Graphics 620) - 7834 MiB free\n" +
		"load_tensors: offloaded 33/33 layers to GPU\n" +
		"\n" + logRunMarker + "b.gguf at y ===\n" +
		"llama_prepare_model_devices: using device Vulkan1 (NVIDIA GeForce 940MX) - 1987 MiB free\n" +
		"load_tensors: offloaded 12/33 layers to GPU\n"
	got := LastLoadSummary(log)
	if !strings.Contains(got, "NVIDIA GeForce 940MX") || !strings.Contains(got, "12 of 33 layers on the GPU") {
		t.Errorf("LastLoadSummary = %q", got)
	}
	if LastLoadSummary("nothing useful\n") != "" {
		t.Error("a log that says nothing made a sentence")
	}
}
