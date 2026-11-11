package engine

import (
	"fmt"
	"regexp"
	"strings"
)

// Which GPU the engine uses (1.8.0, issue #72): gpu_device in config.toml.
//
//	"auto"   llama.cpp's own choice: every dedicated GPU, an integrated one
//	         only when there is no dedicated one. The default.
//	"none"   no GPU at all: --device none, the CPU does everything.
//	"Vulkan1" (or "CUDA0,CUDA1") one or more device IDs as --list-devices
//	         names them, passed to llama-server as --device.
//
// The value is checked against a fixed pattern before it is stored, and
// against the engine's own device list before it is used: an ID is handed to
// llama-server as one argument, never through a shell, and one that is not in
// the list -- a card that was removed, a driver that stopped exposing it --
// falls back to automatic with a warning instead of stopping the engine.

// deviceSetting is "auto", "none", or 1-8 comma-separated IDs shaped like the
// ones --list-devices prints: a letter, letters or digits, a trailing number.
var deviceSetting = regexp.MustCompile(`^(auto|none|[A-Za-z][A-Za-z0-9]{0,15}[0-9]{1,3}(,[A-Za-z][A-Za-z0-9]{0,15}[0-9]{1,3}){0,7})$`)

// ValidDeviceSetting reports whether s may be stored as gpu_device.
func ValidDeviceSetting(s string) bool { return deviceSetting.MatchString(s) }

// ResolveDevice turns gpu_device into the --device argument for this machine:
// "" for automatic (no argument), "none", or the IDs as the engine spells
// them. warning is non-empty when the setting could not be used as written.
func ResolveDevice(want string, devs []Device, probeErr error) (arg, warning string) {
	want = strings.TrimSpace(want)
	switch {
	case want == "" || strings.EqualFold(want, "auto"):
		return "", ""
	case strings.EqualFold(want, "none"):
		return "none", ""
	case !ValidDeviceSetting(want):
		return "", fmt.Sprintf("gpu_device = %q is not a device name; using the automatic choice", truncateString(want, 64))
	case probeErr != nil:
		return "", fmt.Sprintf("gpu_device = %q could not be checked (%v); using the automatic choice", want, probeErr)
	}
	var out []string
	for _, id := range strings.Split(want, ",") {
		found := ""
		for _, d := range devs {
			if strings.EqualFold(d.ID, id) {
				found = d.ID
				break
			}
		}
		if found == "" {
			return "", fmt.Sprintf("gpu_device = %q: %s is not among this engine's devices (%s); using the automatic choice",
				want, id, deviceIDs(devs))
		}
		out = append(out, found)
	}
	return strings.Join(out, ","), ""
}

func deviceIDs(devs []Device) string {
	if len(devs) == 0 {
		return "none found"
	}
	ids := make([]string, len(devs))
	for i, d := range devs {
		ids[i] = d.ID
	}
	return strings.Join(ids, ", ")
}

func truncateString(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// PrimeOffered reports whether the PRIME offload switch is worth offering:
// on a hybrid laptop whose NVIDIA card the engine cannot see, Vulkan lists
// only the integrated GPU. A machine with a dedicated GPU in the list needs no
// such help.
func PrimeOffered(devs []Device) bool {
	integrated := false
	for _, d := range devs {
		if !d.Integrated {
			return false
		}
		integrated = true
	}
	return integrated
}

// PrimeEnv is what prime-run sets for Vulkan, as a fixed pair: the engine
// process alone gets them, when gpu_prime_offload is on (Linux only).
var PrimeEnv = []string{"__NV_PRIME_RENDER_OFFLOAD=1", "__VK_LAYER_NV_optimus=NVIDIA_only"}

// SmallCardMiB is where a GPU stops holding most of a typical model: under
// about 3 GB, most layers run on the CPU, and the Performance box says so.
const SmallCardMiB = 3 * 1024

// EngineChoice is what the Linux launcher wrote about the engine it picked
// (installer-linux/gobbonet-launch, pick_engine): the GPU build, or the CPU
// build and why. Windows has one build and no such file.
type EngineChoice struct {
	Build  string // "gpu", "cpu" or "none"
	Reason string // why the CPU build, in the launcher's words
}

// ParseEngineChoice reads the launcher's engine-choice file: key=value lines.
// Only the two keys are taken, each cut to one line of 300 characters.
func ParseEngineChoice(text string) EngineChoice {
	var c EngineChoice
	for _, line := range strings.Split(text, "\n") {
		k, v, ok := strings.Cut(strings.TrimRight(line, "\r"), "=")
		if !ok {
			continue
		}
		v = truncateString(strings.TrimSpace(v), 300)
		switch strings.TrimSpace(k) {
		case "build":
			if v == "gpu" || v == "cpu" || v == "none" {
				c.Build = v
			}
		case "reason":
			c.Reason = v
		}
	}
	return c
}
