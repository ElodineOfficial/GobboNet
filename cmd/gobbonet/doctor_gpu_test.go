package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/engine"
)

// doctor's GPU section (1.8.0, #72).

func withProbe(t *testing.T, devs []engine.Device, err error) {
	t.Helper()
	old := doctorProbe
	doctorProbe = func(string) ([]engine.Device, error) { return devs, err }
	t.Cleanup(func() { doctorProbe = old })
}

func TestDoctorSaysTheLauncherFellBackToTheCPU(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the launcher's engine-choice note is Linux only")
	}
	dir := t.TempDir()
	choice := filepath.Join(dir, "engine-choice")
	os.WriteFile(choice, []byte("build=cpu\nreason=the GPU build would not start: error while loading shared libraries: libvulkan.so.1\n"), 0o600)
	withProbe(t, nil, nil)
	cfg := config.Default()
	cfg.DataDir = dir
	var out bytes.Buffer
	reportGPU(&out, cfg, "/opt/gobbonet/llama-cpp-cpu/llama-server", choice)
	got := out.String()
	for _, want := range []string{"engine build: CPU ONLY", "why: the GPU build would not start: error while loading shared libraries: libvulkan.so.1",
		"Usually a missing Vulkan driver", "devices:      none"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}
}

// 1.8.1: on a system without OpenSSL 3 (Fedora 45 and later), the AppImage's
// and the ZIP's launcher gives the engine GobboNet's own copy; doctor says so,
// and says nothing when the engine uses the system's.
func TestDoctorSaysWhoseOpenSSL(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the launcher's engine-choice note is Linux only")
	}
	dir := t.TempDir()
	choice := filepath.Join(dir, "engine-choice")
	withProbe(t, nil, nil)
	cfg := config.Default()
	cfg.DataDir = dir
	var out bytes.Buffer
	os.WriteFile(choice, []byte("build=gpu\nreason=\nopenssl=bundled\n"), 0o600)
	reportGPU(&out, cfg, "/x/llama-cpp/llama-server", choice)
	if got := out.String(); !strings.Contains(got, "openssl:      GobboNet's own OpenSSL 3 -- this system has none") ||
		!strings.Contains(got, "openssl3-libs") {
		t.Errorf("bundled OpenSSL not reported:\n%s", got)
	}
	for _, text := range []string{"build=gpu\nreason=\nopenssl=system\n", "build=gpu\nreason=\n"} {
		out.Reset()
		os.WriteFile(choice, []byte(text), 0o600)
		reportGPU(&out, cfg, "/x/llama-cpp/llama-server", choice)
		if strings.Contains(out.String(), "openssl:") {
			t.Errorf("%q: doctor mentioned OpenSSL:\n%s", text, out.String())
		}
	}
}

func TestDoctorListsDevicesAndWhatGPUDeviceDoes(t *testing.T) {
	dir := t.TempDir()
	devs := []engine.Device{
		{ID: "Vulkan0", Name: "Intel(R) HD Graphics 620", TotalMiB: 7834, Integrated: true},
		{ID: "Vulkan1", Name: "NVIDIA GeForce 940MX", TotalMiB: 2048},
	}
	withProbe(t, devs, nil)
	cfg := config.Default()
	cfg.DataDir = dir
	os.WriteFile(cfg.LogFile(), []byte("=== GobboNet: starting llama-server for a.gguf at x ===\n"+
		"llama_prepare_model_devices: using device Vulkan1 (NVIDIA GeForce 940MX) - 1987 MiB free\n"+
		"load_tensors: offloaded 12/33 layers to GPU\n"), 0o600)
	var out bytes.Buffer
	reportGPU(&out, cfg, "/x/llama-server", filepath.Join(dir, "none"))
	got := out.String()
	for _, want := range []string{"Vulkan0   Intel(R) HD Graphics 620, 7834 MiB (integrated", "Vulkan1   NVIDIA GeForce 940MX, 2048 MiB (dedicated)",
		"gpu_device:   auto -- llama.cpp chooses", "(here: Vulkan1)", "small card:   Vulkan1 has 2048 MiB", "last load:    ", "12 of 33 layers on the GPU"} {
		if !strings.Contains(got, want) {
			t.Errorf("missing %q in:\n%s", want, got)
		}
	}

	cfg.GPUDevice = "CUDA0"
	out.Reset()
	reportGPU(&out, cfg, "/x/llama-server", "")
	if !strings.Contains(out.String(), "CUDA0 is not among this engine's devices") {
		t.Errorf("a stale gpu_device is not explained:\n%s", out.String())
	}
	out.Reset()
	reportGPU(&out, cfg, "", "")
	if !strings.Contains(out.String(), "remote mode") {
		t.Errorf("remote mode:\n%s", out.String())
	}
}

func TestDoctorOffersPrimeOnlyForAnIntegratedOnlyList(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("PRIME offload is Linux only")
	}
	withProbe(t, []engine.Device{{ID: "Vulkan0", Name: "Intel(R) HD Graphics 620", TotalMiB: 7834, Integrated: true}}, nil)
	var out bytes.Buffer
	reportGPU(&out, config.Default(), "/x/llama-server", "")
	if !strings.Contains(out.String(), "gpu_prime_offload = true") {
		t.Errorf("PRIME not suggested:\n%s", out.String())
	}
}
