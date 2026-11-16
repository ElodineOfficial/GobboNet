package engine

// GPU memory, as the bundled llama.cpp sees it (roadmap 1.7.7 #8a).
//
// The Linux setup wizard warns before downloading a model that wants more GPU
// memory than the machine has, as launch.bat and the Windows installer already
// do. Windows gets its figure from hardware-probe.ps1; Linux has no equivalent,
// so the figure comes from the engine itself: `llama-server --list-devices`
// asks every backend it was built with, through the same drivers it will use
// to run the model, with no extra tools and no model loaded.
//
// The parsing follows hardware-probe.ps1's ConvertFrom-LlamaDeviceList, which
// has met real machines: device names carry their own parentheses, the memory
// group is anchored to the end of the line, and Vulkan's `uma: 1` marks an
// integrated GPU, whose "total" is a share of system RAM rather than VRAM.

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Device is one non-CPU device llama.cpp can use.
type Device struct {
	ID         string `json:"id"`   // "CUDA0", "Vulkan1", "ROCm0"
	Name       string `json:"name"` // "NVIDIA GeForce RTX 3060"
	TotalMiB   int    `json:"total_mib"`
	FreeMiB    int    `json:"free_mib"`
	Integrated bool   `json:"integrated"`
}

// From common_print_available_devices (common/arg.cpp:1139-1162 at b10456):
//
//	Available devices:
//	  CUDA0: NVIDIA GeForce RTX 3060 (12288 MiB, 11873 MiB free)
//
// or "  (none)". The name is lazy and the memory group anchored to the end,
// because names such as "Intel(R) Graphics (ARL)" contain parentheses.
var (
	deviceLine = regexp.MustCompile(`^\s*([A-Za-z][A-Za-z0-9]*\d)\s*:\s*(.+?)\s*\(\s*(\d+)\s*MiB\s*,\s*(\d+)\s*MiB\s+free\s*\)\s*$`)
	vulkanUMA  = regexp.MustCompile(`^\s*ggml_vulkan:\s*(\d+)\s*=\s*.+?\|\s*uma:\s*([01])`)
)

// ParseDeviceList reads --list-devices output. stdout carries the list and
// stderr the backends' own start-up lines (where Vulkan's uma flag is); both
// are read, as the Windows probe does, since builds differ in which stream
// they use. ramMiB, when known, lets a device that holds most of system
// memory be recognised as integrated -- nothing discrete does.
func ParseDeviceList(stdout, stderr string, ramMiB int) []Device {
	uma := map[string]bool{}
	for _, line := range strings.Split(stderr, "\n") {
		if m := vulkanUMA.FindStringSubmatch(strings.TrimRight(line, "\r")); m != nil {
			uma["Vulkan"+m[1]] = m[2] == "1"
		}
	}
	var out []Device
	seen := map[string]bool{}
	for _, line := range strings.Split(stdout+"\n"+stderr, "\n") {
		m := deviceLine.FindStringSubmatch(strings.TrimRight(line, "\r"))
		if m == nil || strings.HasPrefix(strings.ToUpper(m[1]), "CPU") || seen[m[1]] {
			continue
		}
		seen[m[1]] = true
		total, _ := strconv.Atoi(m[3])
		free, _ := strconv.Atoi(m[4])
		d := Device{ID: m[1], Name: m[2], TotalMiB: total, FreeMiB: free}
		if flag, ok := uma[d.ID]; ok {
			d.Integrated = flag
		} else {
			d.Integrated = looksIntegrated(d.Name, total, ramMiB)
		}
		out = append(out, d)
	}
	return out
}

// looksIntegrated is hardware-probe.ps1's Test-LooksIntegrated, minus the uma
// flag (handled by the caller, and authoritative when present).
var (
	trademarks      = regexp.MustCompile(`(?i)\((R|TM|C)\)`)
	integratedAny   = regexp.MustCompile(`(?i)UHD Graphics|\bHD Graphics\b|\bIris\b|Vega \d+ Graphics|Microsoft Basic|Adreno|\bMali\b|llvmpipe`)
	integratedIntel = regexp.MustCompile(`(?i)Intel\s+Graphics|Arc\s+Graphics|Arc\s+\d{3}V`)
	integratedAMD   = regexp.MustCompile(`(?i)Radeon\s+Graphics\s*$|\b[6-9]\d{2}M\b|Radeon\s*8\d{3}S|RADV\s*(PHOENIX|REMBRANDT|RAPHAEL|VANGOGH|RENOIR|CEZANNE|STRIX)`)
	integratedApple = regexp.MustCompile(`(?i)^Apple\s+M[0-9]`)
	// Names no integrated GPU carries. NVIDIA has no integrated GPU on a PC;
	// Radeon RX and Arc A/B are discrete lines. Checked before the share-of-RAM
	// signal below, which on its own would call an 8 GB card in an 8 GB
	// machine integrated -- a budget build that is not rare at all.
	discreteName     = regexp.MustCompile(`(?i)NVIDIA|GeForce|Quadro|Tesla|\bRTX\b|\bGTX\b|Radeon\s+(Pro\s+)?RX\b|Radeon\s+Pro\s+W|\bArc\s+[AB]\d{3}\b`)
	collapseSpaces   = regexp.MustCompile(`\s+`)
	vendorIntelMatch = regexp.MustCompile(`(?i)intel`)
	vendorAMDMatch   = regexp.MustCompile(`(?i)amd|radeon|radv`)
)

func looksIntegrated(name string, totalMiB, ramMiB int) bool {
	n := strings.TrimSpace(collapseSpaces.ReplaceAllString(trademarks.ReplaceAllString(name, " "), " "))
	if integratedAny.MatchString(n) {
		return true
	}
	if vendorIntelMatch.MatchString(n) && integratedIntel.MatchString(n) {
		return true
	}
	if vendorAMDMatch.MatchString(n) && integratedAMD.MatchString(n) {
		return true
	}
	// Apple Silicon has one unified memory pool. llama.cpp reports the amount
	// Metal may use, not separate VRAM, so presenting it as a dedicated card
	// makes the model-fit warning compare two names for the same RAM.
	if integratedApple.MatchString(n) {
		return true
	}
	if discreteName.MatchString(n) {
		return false
	}
	return ramMiB > 0 && totalMiB > 0 && float64(totalMiB)/float64(ramMiB) >= 0.80
}

// standardVRAMGB and NominalGB are hardware-probe.ps1's ConvertTo-NominalGB: a
// card's reported capacity is a little under its label (a 16 GB card reports
// 16368 MiB), so a reading within 2.5% below a standard size is that size.
// Flooring instead would tell every 16 GB card owner they have 15 GB, and
// warn them about every 16 GB model.
var standardVRAMGB = []int{1, 2, 3, 4, 5, 6, 8, 10, 11, 12, 14, 16, 20, 24, 32, 40, 48, 64, 80, 96, 128, 141, 192, 256}

func NominalGB(mib int) int {
	if mib <= 0 {
		return 0
	}
	exact := float64(mib) / 1024
	for _, std := range standardVRAMGB {
		if float64(std) < exact {
			continue
		}
		if (float64(std)-exact)/float64(std) <= 0.025 {
			return std
		}
		break
	}
	return int(exact)
}

// DedicatedGPU is the device whose memory decides what fits: the largest
// discrete one. nil when there is none -- no GPU, a CPU-only build, or only an
// integrated GPU, whose memory is system RAM and not a figure to warn against.
//
// The largest rather than the sum: llama.cpp can split a model across cards,
// so a sum would be right for two discrete cards -- but one integrated GPU
// misread as discrete would then hide a real shortfall. A warning too many is
// a click; a warning too few is a 20 GB download that crawls.
func DedicatedGPU(devs []Device) *Device {
	var best *Device
	for i := range devs {
		d := &devs[i]
		if d.Integrated || d.TotalMiB <= 0 {
			continue
		}
		if best == nil || d.TotalMiB > best.TotalMiB {
			best = d
		}
	}
	return best
}

// AppleUnifiedGPU returns the largest Apple Silicon Metal device. Its reported
// total is a usable unified-memory budget, not separate VRAM, but it is still
// the honest number to compare with a model's fit requirement.
func AppleUnifiedGPU(devs []Device) *Device {
	var best *Device
	for i := range devs {
		d := &devs[i]
		if !d.Integrated || d.TotalMiB <= 0 || !integratedApple.MatchString(strings.TrimSpace(d.Name)) {
			continue
		}
		if best == nil || d.TotalMiB > best.TotalMiB {
			best = d
		}
	}
	return best
}

// probeTimeout bounds --list-devices. A wedged GPU driver can hang device
// enumeration; the Windows probe met exactly that, and the answer then is "not
// known", never a wizard stuck waiting.
var probeTimeout = 20 * time.Second

var (
	probeMu    sync.Mutex
	probeStamp string
	probeDevs  []Device
	probeErr   error
)

// ProbeDevices runs exe --list-devices, cached per executable path, size and
// modification time, the way the supervisor caches --help: replacing the
// engine invalidates it, and asking twice costs nothing.
func ProbeDevices(exe string) ([]Device, error) {
	if exe == "" {
		return nil, fmt.Errorf("no engine")
	}
	st, err := os.Stat(exe)
	if err != nil {
		return nil, err
	}
	stamp := fmt.Sprintf("%s:%d:%d", exe, st.Size(), st.ModTime().UnixNano())

	probeMu.Lock()
	defer probeMu.Unlock()
	if stamp == probeStamp {
		return probeDevs, probeErr
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "--list-devices")
	cmd.WaitDelay = time.Second
	var stdout, stderr strings.Builder
	cmd.Stdout, cmd.Stderr = &limited{w: &stdout, n: 256 << 10}, &limited{w: &stderr, n: 256 << 10}
	runErr := cmd.Run()
	switch {
	case ctx.Err() != nil:
		probeDevs, probeErr = nil, fmt.Errorf("the engine took longer than %s to list its devices (a graphics driver may be stuck)", probeTimeout)
	case runErr != nil && !strings.Contains(stdout.String(), "Available devices"):
		probeDevs, probeErr = nil, fmt.Errorf("could not list devices: %w", runErr)
	default:
		probeDevs, probeErr = ParseDeviceList(stdout.String(), stderr.String(), SystemRAMMiB()), nil
	}
	probeStamp = stamp
	return probeDevs, probeErr
}

// limited keeps the first n bytes; a misbehaving engine cannot fill memory.
type limited struct {
	w *strings.Builder
	n int
}

func (l *limited) Write(p []byte) (int, error) {
	if room := l.n - l.w.Len(); room > 0 {
		if len(p) > room {
			l.w.Write(p[:room])
		} else {
			l.w.Write(p)
		}
	}
	return len(p), nil
}

// SystemRAMMiB is this machine's physical memory, or 0 when it cannot be read.
// Linux exposes MemTotal in /proc. macOS exposes the byte count through
// sysctl; using the command keeps this package cgo-free.
func SystemRAMMiB() int {
	if runtime.GOOS == "darwin" {
		out, err := exec.Command("sysctl", "-n", "hw.memsize").Output()
		if err != nil {
			return 0
		}
		return ramMiBFromSysctl(string(out))
	}
	f, err := os.Open("/proc/meminfo")
	if err != nil {
		return 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) >= 2 && fields[0] == "MemTotal:" {
			kb, _ := strconv.Atoi(fields[1])
			return kb / 1024
		}
	}
	return 0
}

func ramMiBFromSysctl(text string) int {
	bytes, err := strconv.ParseUint(strings.TrimSpace(text), 10, 64)
	if err != nil || bytes == 0 {
		return 0
	}
	return int(bytes / (1024 * 1024))
}
