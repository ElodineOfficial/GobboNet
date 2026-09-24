package supervisor

import (
	"fmt"
	"strings"
)

type reportedBuffer struct {
	kind string
	host bool
	mib  float64
}

// Keep the latest size for each named buffer, not every log occurrence. Model
// reloads reset the entire summary. Unknown formats remain in the full log.
func (s *loadSummary) feedBuffer(flat string) {
	for _, kind := range []string{"model", "KV", "compute", "RS"} {
		marker := kind + " buffer size"
		pos := strings.Index(flat, marker)
		if pos < 0 {
			continue
		}
		prefix := strings.TrimSpace(flat[:pos])
		backend := prefix
		if i := strings.LastIndex(backend, ":"); i >= 0 {
			backend = strings.TrimSpace(backend[i+1:])
		}
		if backend == "" {
			return
		}
		mib := parseMiB(flat[pos:])
		if mib <= 0 {
			return
		}
		if s.buffers == nil {
			s.buffers = make(map[string]reportedBuffer)
		}
		key := prefix + " " + kind
		// Bound even unusual/custom engines' reporting.
		if _, exists := s.buffers[key]; !exists && len(s.buffers) >= 128 {
			return
		}
		// CUDA_Host, Vulkan_Host and CPU_Mapped are host allocations, not VRAM.
		host := strings.HasPrefix(backend, "CPU") || strings.Contains(strings.ToLower(backend), "host")
		s.buffers[key] = reportedBuffer{kind: kind, host: host, mib: mib}
		s.gpuMiB, s.cpuMiB = 0, 0
		for _, b := range s.buffers {
			if b.kind != "model" {
				continue
			}
			if b.host {
				s.cpuMiB += b.mib
			} else {
				s.gpuMiB += b.mib
			}
		}
		return
	}
}

func (s *loadSummary) MemoryLine() string {
	totals := map[string]float64{}
	seen := map[string]bool{}
	for _, b := range s.buffers {
		if b.host {
			continue
		}
		totals[b.kind] += b.mib
		seen[b.kind] = true
	}
	if len(seen) == 0 {
		return ""
	}
	parts := []string{}
	total := 0.0
	for _, kind := range []string{"model", "KV", "compute", "RS"} {
		if seen[kind] {
			parts = append(parts, kind+" "+gigabytes(totals[kind]))
			total += totals[kind]
		}
	}
	line := "engine-reported GPU buffers: " + strings.Join(parts, ", ") + "; subtotal " + gigabytes(total) + ". This excludes unreported/driver allocations and is not total dedicated VRAM usage"
	if s.actualCtx > 0 {
		line += fmt.Sprintf("; actual context %s tokens", commas(s.actualCtx))
	}
	return line
}
