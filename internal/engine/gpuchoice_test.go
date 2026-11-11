package engine

import (
	"errors"
	"strings"
	"testing"
)

// gpu_device and the hybrid laptop of issue #72: an Intel iGPU and an NVIDIA
// GeForce 940MX with 2 GB, as Vulkan lists them.
const hybridStdout = "Available devices:\n" +
	"  Vulkan0: Intel(R) HD Graphics 620 (KBL GT2) (7834 MiB, 7834 MiB free)\n" +
	"  Vulkan1: NVIDIA GeForce 940MX (2048 MiB, 1987 MiB free)\n"
const hybridStderr = "ggml_vulkan: Found 2 Vulkan devices:\n" +
	"ggml_vulkan: 0 = Intel(R) HD Graphics 620 (KBL GT2) (Intel open-source Mesa driver) | uma: 1 | fp16: 1\n" +
	"ggml_vulkan: 1 = NVIDIA GeForce 940MX (NVIDIA) | uma: 0 | fp16: 0\n"

func TestParseDeviceListIntelAndNVIDIA(t *testing.T) {
	devs := ParseDeviceList(hybridStdout, hybridStderr, 15668)
	if len(devs) != 2 || devs[0].ID != "Vulkan0" || !devs[0].Integrated || devs[1].ID != "Vulkan1" || devs[1].Integrated {
		t.Fatalf("devices = %+v, want the Intel integrated and the NVIDIA dedicated", devs)
	}
	if d := DedicatedGPU(devs); d == nil || d.ID != "Vulkan1" || d.TotalMiB != 2048 {
		t.Errorf("DedicatedGPU = %+v, want the 940MX", d)
	}
	if devs[1].TotalMiB >= SmallCardMiB {
		t.Error("a 2 GB card counts as small")
	}
	if PrimeOffered(devs) {
		t.Error("PRIME offered with the NVIDIA card already visible")
	}
	onlyIntel := ParseDeviceList("Available devices:\n  Vulkan0: Intel(R) HD Graphics 620 (KBL GT2) (7834 MiB, 7834 MiB free)\n",
		"ggml_vulkan: 0 = Intel(R) HD Graphics 620 (KBL GT2) (Intel open-source Mesa driver) | uma: 1 | fp16: 1\n", 15668)
	if !PrimeOffered(onlyIntel) {
		t.Error("PRIME not offered when the engine sees only the integrated GPU")
	}
	if PrimeOffered(nil) {
		t.Error("PRIME offered with no GPU at all")
	}
}

func TestValidDeviceSetting(t *testing.T) {
	for _, ok := range []string{"auto", "none", "Vulkan0", "Vulkan1", "CUDA0", "CUDA0,CUDA1", "ROCm0", "SYCL12"} {
		if !ValidDeviceSetting(ok) {
			t.Errorf("%q refused", ok)
		}
	}
	for _, bad := range []string{"", "AUTO ", "Vulkan", "0", "Vulkan0;rm -rf /", "--model x", "Vulkan0, CUDA0", "../x", "Vulkan0,", strings.Repeat("A", 20) + "0"} {
		if ValidDeviceSetting(bad) {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestResolveDevice(t *testing.T) {
	devs := ParseDeviceList(hybridStdout, hybridStderr, 15668)
	for _, c := range []struct {
		want, arg string
		warns     bool
	}{
		{"auto", "", false},
		{"", "", false},
		{"none", "none", false},
		{"Vulkan1", "Vulkan1", false},
		{"vulkan1", "Vulkan1", false}, // the engine's spelling goes on the command line
		{"Vulkan0,Vulkan1", "Vulkan0,Vulkan1", false},
		{"CUDA0", "", true},         // a card that is not there: automatic, and say so
		{"Vulkan1,CUDA0", "", true}, // all or nothing
		{"rm -rf /", "", true},      // never a device
	} {
		arg, warning := ResolveDevice(c.want, devs, nil)
		if arg != c.arg || (warning != "") != c.warns {
			t.Errorf("ResolveDevice(%q) = %q, %q", c.want, arg, warning)
		}
	}
	if arg, warning := ResolveDevice("Vulkan1", nil, errors.New("driver stuck")); arg != "" || !strings.Contains(warning, "could not be checked") {
		t.Errorf("an unlistable engine: %q, %q", arg, warning)
	}
	if _, warning := ResolveDevice("CUDA0", devs, nil); !strings.Contains(warning, "Vulkan0, Vulkan1") {
		t.Errorf("the warning should name the devices there are: %q", warning)
	}
}

func TestParseEngineChoice(t *testing.T) {
	c := ParseEngineChoice("build=cpu\nreason=the GPU build would not start: error while loading shared libraries: libvulkan.so.1\nextra=ignored\n")
	if c.Build != "cpu" || !strings.Contains(c.Reason, "libvulkan.so.1") {
		t.Errorf("%+v", c)
	}
	if c := ParseEngineChoice("build=rocket\nreason=" + strings.Repeat("x", 1000)); c.Build != "" || len(c.Reason) > 303 {
		t.Errorf("an unknown build or an overlong reason got through: %+v", c)
	}
}
