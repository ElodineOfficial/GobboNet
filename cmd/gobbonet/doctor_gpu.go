package main

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/engine"
	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

// doctorProbe is engine.ProbeDevices, replaceable in tests.
var doctorProbe = engine.ProbeDevices

// reportGPU is doctor's GPU section (1.8.0, issue #72): which engine build
// runs and why, every device the engine can see, what gpu_device makes of
// them, whether PRIME offload would help, and where the last load went.
// Everything comes from the engine itself and from files on this PC.
func reportGPU(w io.Writer, cfg config.Config, enginePath, choicePath string) {
	fmt.Fprintln(w, "GPU")
	if enginePath == "" {
		fmt.Fprintln(w, "  (remote mode: no engine runs on this PC, so there is no GPU to report)")
		return
	}
	if runtime.GOOS == "linux" {
		if raw, err := os.ReadFile(choicePath); err == nil {
			c := engine.ParseEngineChoice(string(raw))
			switch c.Build {
			case "gpu":
				fmt.Fprintln(w, "  engine build: GPU (Vulkan), picked by the launcher")
			case "cpu":
				fmt.Fprintln(w, "  engine build: CPU ONLY -- the launcher fell back to it because the GPU build would not start")
				if c.Reason != "" {
					fmt.Fprintf(w, "                why: %s\n", c.Reason)
				}
				fmt.Fprintln(w, "                Usually a missing Vulkan driver: install your distribution's Vulkan")
				fmt.Fprintln(w, "                loader and the driver for your card (mesa-vulkan-drivers, or NVIDIA's).")
			case "none":
				fmt.Fprintln(w, "  engine build: none bundled")
			}
		}
	}

	devs, err := doctorProbe(enginePath)
	switch {
	case err != nil:
		fmt.Fprintf(w, "  devices:      could not list them: %v\n", err)
	case len(devs) == 0:
		fmt.Fprintln(w, "  devices:      none -- the engine sees no GPU, so the model runs on the CPU")
	default:
		fmt.Fprintln(w, "  devices:      (as llama-server --list-devices names them)")
		for _, d := range devs {
			kind := "dedicated"
			if d.Integrated {
				kind = "integrated: its memory is system RAM"
			}
			fmt.Fprintf(w, "    %-9s %s, %d MiB (%s)\n", d.ID, d.Name, d.TotalMiB, kind)
		}
	}

	setting := strings.TrimSpace(cfg.GPUDevice)
	arg, warning := engine.ResolveDevice(setting, devs, err)
	switch {
	case warning != "":
		fmt.Fprintf(w, "  gpu_device:   %s -- %s\n", setting, warning)
	case arg == "":
		auto := "llama.cpp chooses: every dedicated GPU, an integrated one only when there is none"
		if d := engine.DedicatedGPU(devs); d != nil {
			auto += " (here: " + d.ID + ")"
		}
		fmt.Fprintf(w, "  gpu_device:   auto -- %s\n", auto)
	case arg == "none":
		fmt.Fprintln(w, "  gpu_device:   none -- the model runs on the CPU only")
	default:
		fmt.Fprintf(w, "  gpu_device:   %s\n", arg)
	}

	if runtime.GOOS == "linux" {
		state := "off"
		if cfg.GPUPrimeOffload {
			state = "on"
		}
		fmt.Fprintf(w, "  prime offload: %s", state)
		if err == nil && engine.PrimeOffered(devs) {
			fmt.Fprint(w, " -- the engine sees only an integrated GPU. On a laptop with an NVIDIA card too,\n")
			fmt.Fprint(w, "                gpu_prime_offload = true (CONFIG > Performance) lets the engine use it.")
		}
		fmt.Fprintln(w)
	}

	for _, d := range devs {
		used := arg == "" && !d.Integrated || strings.Contains(","+arg+",", ","+d.ID+",")
		if used && !d.Integrated && d.TotalMiB > 0 && d.TotalMiB < engine.SmallCardMiB {
			fmt.Fprintf(w, "  small card:   %s has %d MiB: only a few layers fit, and the rest run on the CPU.\n", d.ID, d.TotalMiB)
		}
	}

	if text, err := readTail(cfg.LogFile(), doctorLogTail); err == nil {
		if line := supervisor.LastLoadSummary(text); line != "" {
			fmt.Fprintf(w, "  last load:    %s\n", line)
		}
	}
}
