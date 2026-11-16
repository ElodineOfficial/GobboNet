package engine

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// Roadmap 1.7.7 #8a. The fixtures are real --list-devices shapes: the format
// string is common/arg.cpp:1160 at b10456, and the device names are the ones
// hardware-probe.ps1's own fixtures were taken from.

func TestParseDeviceList(t *testing.T) {
	stdout := "Available devices:\n" +
		"  Vulkan0: AMD Radeon RX 7900 XT (20464 MiB, 20464 MiB free)\n" +
		"  Vulkan1: Intel(R) Graphics (ARL) (11577 MiB, 8251 MiB free)\n" +
		"  CUDA0: NVIDIA GeForce RTX 5060 (7708 MiB, 7573 MiB free)\r\n"
	stderr := "ggml_vulkan: Found 2 Vulkan devices:\n" +
		"ggml_vulkan: 0 = AMD Radeon RX 7900 XT (RADV NAVI31) (radv) | uma: 0 | fp16: 1\n" +
		"ggml_vulkan: 1 = Intel(R) Graphics (ARL) (Intel open-source Mesa driver) | uma: 1 | fp16: 1\n"
	devs := ParseDeviceList(stdout, stderr, 32768)
	if len(devs) != 3 {
		t.Fatalf("got %d devices: %+v", len(devs), devs)
	}
	want := []Device{
		{ID: "Vulkan0", Name: "AMD Radeon RX 7900 XT", TotalMiB: 20464, FreeMiB: 20464},
		{ID: "Vulkan1", Name: "Intel(R) Graphics (ARL)", TotalMiB: 11577, FreeMiB: 8251, Integrated: true},
		{ID: "CUDA0", Name: "NVIDIA GeForce RTX 5060", TotalMiB: 7708, FreeMiB: 7573},
	}
	for i := range want {
		if devs[i] != want[i] {
			t.Errorf("device %d:\n got  %+v\n want %+v", i, devs[i], want[i])
		}
	}
	if d := DedicatedGPU(devs); d == nil || d.ID != "Vulkan0" {
		t.Errorf("DedicatedGPU = %+v, want the 7900 XT", d)
	}
}

func TestNoGPUAndNonsense(t *testing.T) {
	for name, out := range map[string]string{
		"none":    "Available devices:\n  (none)\n",
		"empty":   "",
		"garbage": "error: unknown argument: --list-devices\nusage: llama-server ...\n",
		"cpu":     "Available devices:\n  CPU0: AMD Ryzen 9 (65536 MiB, 60000 MiB free)\n",
	} {
		devs := ParseDeviceList(out, "", 0)
		if len(devs) != 0 {
			t.Errorf("%s: got %+v", name, devs)
		}
		if DedicatedGPU(devs) != nil {
			t.Errorf("%s: found a GPU in nothing", name)
		}
	}
}

// An integrated GPU's "total" is system RAM. Counting it as VRAM would tell a
// laptop it can run a 24 GB model on its GPU.
func TestIntegratedIsNotVRAM(t *testing.T) {
	cases := []struct {
		name  string
		total int
		ram   int
		want  bool
	}{
		{"AMD Radeon 780M Graphics", 29696, 32768, true}, // by name, and by share of RAM
		{"AMD Radeon Graphics", 4096, 0, true},
		{"Intel(R) UHD Graphics 770", 4096, 0, true},
		{"Intel(R) Arc(TM) Graphics", 8192, 0, true},
		{"Intel(R) Arc(TM) 140V GPU", 8192, 0, true},
		{"AMD Radeon 8060S Graphics", 98304, 131072, true},
		{"llvmpipe (LLVM 17.0.6, 256 bits)", 65536, 0, true},
		{"Some Unknown GPU", 30000, 32768, true}, // holds most of system RAM
		{"Apple M1 Max", 25559, 32768, true},     // Metal reports unified memory, not VRAM
		{"Intel(R) Arc(TM) A770 Graphics", 16256, 32768, false},
		{"NVIDIA GeForce RTX 4090", 24564, 65536, false},
		{"AMD Radeon RX 7800 XT", 16368, 32768, false},
		// A budget build: an 8 GB card in an 8 GB machine is still discrete.
		{"NVIDIA GeForce RTX 4060", 8188, 8029, false},
		{"AMD Radeon RX 6600", 8176, 8029, false},
		{"Intel(R) Arc(TM) B580 Graphics", 12216, 8029, false},
	}
	for _, c := range cases {
		if got := looksIntegrated(c.name, c.total, c.ram); got != c.want {
			t.Errorf("looksIntegrated(%q) = %v, want %v", c.name, got, c.want)
		}
	}
	only := ParseDeviceList("  Vulkan0: AMD Radeon 780M Graphics (29696 MiB, 28000 MiB free)\n", "", 32768)
	if DedicatedGPU(only) != nil {
		t.Error("an integrated GPU alone was offered as the VRAM figure")
	}
}

func TestAppleMetalFixtureUsesUnifiedMemory(t *testing.T) {
	stdout := "Available devices:\n  MTL0: Apple M1 Max (25559 MiB, 25558 MiB free)\n  BLAS: Accelerate (0 MiB, 0 MiB free)\n"
	devs := ParseDeviceList(stdout, "", 32768)
	if len(devs) != 1 || devs[0].ID != "MTL0" || !devs[0].Integrated {
		t.Fatalf("devices = %+v", devs)
	}
	if DedicatedGPU(devs) != nil {
		t.Fatal("Apple unified memory was presented as dedicated VRAM")
	}
	if d := AppleUnifiedGPU(devs); d == nil || d.ID != "MTL0" || d.TotalMiB != 25559 {
		t.Fatalf("AppleUnifiedGPU = %+v", d)
	}
}

func TestMacSysctlMemoryBytesBecomeMiB(t *testing.T) {
	if got := ramMiBFromSysctl("34359738368\n"); got != 32768 {
		t.Fatalf("32 GiB sysctl value = %d MiB", got)
	}
	for _, bad := range []string{"", "not-a-number", "0"} {
		if got := ramMiBFromSysctl(bad); got != 0 {
			t.Errorf("ramMiBFromSysctl(%q) = %d", bad, got)
		}
	}
}

// The uma flag, when Vulkan prints it, beats the name either way.
func TestUMAFlagWins(t *testing.T) {
	stdout := "  Vulkan0: AMD Radeon Graphics (16384 MiB, 16000 MiB free)\n"
	devs := ParseDeviceList(stdout, "ggml_vulkan: 0 = AMD Radeon Graphics (RADV GFX1151) | uma: 0 | fp16: 1\n", 0)
	if devs[0].Integrated {
		t.Error("uma: 0 should beat a name that looks integrated")
	}
}

// hardware-probe.ps1's ConvertTo-NominalGB, case for case.
func TestNominalGB(t *testing.T) {
	for mib, want := range map[int]int{
		24564: 24, // RTX 4090
		16368: 16, // RX 7800 XT
		16256: 16, // Arc A770
		12288: 12,
		8192:  8,
		7708:  7, // 6% short of 8: genuinely less
		15565: 15,
		0:     0,
	} {
		if got := NominalGB(mib); got != want {
			t.Errorf("NominalGB(%d) = %d, want %d", mib, got, want)
		}
	}
}

func fakeEngine(t *testing.T, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell-script stand-in for the engine")
	}
	p := filepath.Join(t.TempDir(), "llama-server")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+script), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func resetProbeCache() { probeStamp, probeDevs, probeErr = "", nil, nil }

func TestProbeDevicesRunsTheEngine(t *testing.T) {
	resetProbeCache()
	exe := fakeEngine(t, `[ "$1" = "--list-devices" ] || exit 9
echo "ggml_cuda_init: found 1 CUDA devices" >&2
echo "Available devices:"
echo "  CUDA0: NVIDIA GeForce RTX 3060 (12288 MiB, 11873 MiB free)"
`)
	devs, err := ProbeDevices(exe)
	if err != nil || len(devs) != 1 || devs[0].Name != "NVIDIA GeForce RTX 3060" || NominalGB(devs[0].TotalMiB) != 12 {
		t.Fatalf("got %+v, %v", devs, err)
	}

	// Cached: asking again does not run it again...
	if err := os.WriteFile(exe+".ran", nil, 0o600); err != nil {
		t.Fatal(err)
	}
	again, _ := ProbeDevices(exe)
	if len(again) != 1 {
		t.Fatalf("cached answer lost: %+v", again)
	}
	// ...but replacing the engine does.
	time.Sleep(10 * time.Millisecond)
	if err := os.WriteFile(exe, []byte("#!/bin/sh\necho 'Available devices:'\necho '  (none)'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	after, err := ProbeDevices(exe)
	if err != nil || len(after) != 0 {
		t.Errorf("a replaced engine kept the old answer: %+v %v", after, err)
	}
}

// A wedged driver must make the answer "not known", quickly -- never a wizard
// waiting forever.
func TestProbeDevicesTimesOut(t *testing.T) {
	resetProbeCache()
	old := probeTimeout
	probeTimeout = 300 * time.Millisecond
	defer func() { probeTimeout = old }()
	exe := fakeEngine(t, "exec sleep 30\n")
	start := time.Now()
	_, err := ProbeDevices(exe)
	if err == nil || !strings.Contains(err.Error(), "longer than") {
		t.Errorf("err = %v, want a timeout", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Errorf("took %s", time.Since(start))
	}
}

func TestProbeDevicesWithoutAnEngine(t *testing.T) {
	resetProbeCache()
	if _, err := ProbeDevices(""); err == nil {
		t.Error("no engine, no error")
	}
	if _, err := ProbeDevices(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("missing engine, no error")
	}
	exe := fakeEngine(t, "echo 'error: unknown argument' >&2; exit 1\n")
	if _, err := ProbeDevices(exe); err == nil {
		t.Error("an engine without --list-devices was not reported")
	}
}
