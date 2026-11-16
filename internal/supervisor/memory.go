package supervisor

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// Help is inspected only when auto placement is requested. No network, extra
// tools or weight loading. A custom/older engine must not silently receive
// unknown flags or fall back to an all-GPU allocation.
func (s *Supervisor) checkMemoryArgs(args []string) error {
	auto := false
	target := itoaInt(s.opts.GPUReserveMiB)
	for i, a := range args {
		if a == "--n-gpu-layers" && i+1 < len(args) && args[i+1] == "auto" {
			auto = true
		}
		if a == "--fit-target" && i+1 < len(args) {
			target = args[i+1]
		}
	}
	if !auto {
		return nil
	}
	if err := s.memoryCapabilities(); err != nil {
		return err
	}

	log.Printf("[memory] automatic GPU placement targets %s MiB free per device; model, context and KV precision stay unchanged", target)
	log.Printf("[memory] CPU offload may use more system RAM and reduce speed; headroom is a target, not a hard memory cap")
	return nil
}

// Cache per executable size/mtime; replacing the engine invalidates the probe.
// The operation mutex serializes access and each load still announces policy.
func (s *Supervisor) memoryCapabilities() (result error) {
	st, err := os.Stat(s.opts.ServerExe)
	if err != nil {
		return err
	}
	stamp := fmt.Sprintf("%s:%d:%d", s.opts.ServerExe, st.Size(), st.ModTime().UnixNano())
	if stamp == s.memoryHelpStamp {
		return s.memoryHelpErr
	}
	defer func() { s.memoryHelpStamp = stamp; s.memoryHelpErr = result }()
	ctx, cancel := context.WithTimeout(context.Background(), memoryProbeTimeout(runtime.GOOS))
	defer cancel()
	cmd := exec.CommandContext(ctx, s.opts.ServerExe, "--help")
	cmd.WaitDelay = time.Second
	output := newRingBuffer(256 * 1024)
	cmd.Stdout, cmd.Stderr = output, output
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("cannot verify engine automatic memory fitting: %w; use the pinned engine or choose an explicit GPU layer count", err)
	}
	help := output.String()
	for _, flag := range []string{"--fit", "--fit-target", "--fit-ctx"} {
		if !strings.Contains(help, flag+" ") {
			return fmt.Errorf("this engine does not advertise %s; install the pinned engine or choose an explicit GPU layer count", flag)
		}
	}
	return nil
}

// memoryProbeTimeout is how long `llama-server --help` may take. Ten seconds
// is ample for a program the system has run before. macOS checks a program on
// its first run, and that alone took 13.7 s for this engine on an M1 Max; the
// installer now pays for that run itself, but an engine placed by hand, or the
// first start after the system forgets it, would otherwise be killed mid-check
// and the failure remembered for the life of the process.
func memoryProbeTimeout(goos string) time.Duration {
	if goos == "darwin" {
		return time.Minute
	}
	return 10 * time.Second
}
