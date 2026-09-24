package supervisor

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

// Help is inspected only when auto placement is requested. No network, extra
// tools or weight loading. A custom/older engine must not silently receive
// unknown flags or fall back to an all-GPU allocation.
func (s *Supervisor) checkMemoryArgs(args []string) error {
	auto := false
	for i, a := range args {
		if a == "--n-gpu-layers" && i+1 < len(args) && args[i+1] == "auto" {
			auto = true
		}
	}
	if !auto {
		return nil
	}
	if err := s.memoryCapabilities(); err != nil {
		return err
	}

	log.Printf("[memory] automatic GPU placement targets %d MiB free per device; model, context and KV precision stay unchanged", s.opts.GPUReserveMiB)
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
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
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
