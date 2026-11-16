package setup

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"testing"
)

// Issue #65: the wizard needs system RAM beside VRAM to offer a
// Mixture-of-Experts model to a smaller card.

func TestRAMFromMeminfoRoundsToTheInstalledSize(t *testing.T) {
	cases := []struct {
		name string
		text string
		want int
	}{
		// MemTotal is below the installed figure: the kernel, firmware and an
		// integrated GPU's share all come out of it.
		{"32 GB laptop", "MemTotal:       32094016 kB\nMemFree:  100 kB\n", 32},
		{"16 GB desktop", "MemFree: 1 kB\nMemTotal:       16264660 kB\n", 16},
		{"64 GB exactly", "MemTotal:       67108864 kB\n", 64},
		{"8 GB less 2 GB for an iGPU", "MemTotal:        6083452 kB\n", 6},
		// Not near any shipped size: report what is there, rounded down, rather
		// than claim RAM the machine does not have.
		{"odd VM size", "MemTotal:       28311552 kB\n", 27},
		{"no MemTotal", "MemFree: 100 kB\n", 0},
		{"garbage", "MemTotal: lots kB\n", 0},
		{"empty", "", 0},
	}
	for _, c := range cases {
		if got := ramGBFromMeminfo(c.text); got != c.want {
			t.Errorf("%s: got %d, want %d", c.name, got, c.want)
		}
	}
}

// The figure must never round up past what is installed by more than the
// tolerance: a fit check that believes in RAM the machine lacks is the bug
// the warning exists to prevent.
func TestRAMFromMeminfoNeverInventsMuchRAM(t *testing.T) {
	for kb := 1 << 20; kb <= 600<<20; kb += 97 << 10 {
		got := ramGBFromMeminfo("MemTotal: " + strconv.Itoa(kb) + " kB\n")
		gib := float64(kb) / (1 << 20)
		if float64(got) > gib*1.09 {
			t.Fatalf("%d kB (%.2f GiB) read as %d GB", kb, gib, got)
		}
	}
}

func TestNominalRAMFromMacSysctlValue(t *testing.T) {
	if got := nominalRAMGB(float64(32768) / 1024); got != 32 {
		t.Fatalf("32768 MiB read as %d GB", got)
	}
}

func TestGPUResponseCarriesSystemRAM(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("/proc/meminfo is Linux only")
	}
	s := newTestServer(t)
	s.opts.ServerExe = gpuEngine(t, "Available devices:\n  CUDA0: NVIDIA GeForce RTX 4060 (8188 MiB, 7900 MiB free)\n")
	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/gpu", nil))
	var raw map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &raw); err != nil {
		t.Fatal(err)
	}
	ram, ok := raw["ram_gb"].(float64)
	if !ok || int(ram) != systemRAMGB() || ram <= 0 {
		t.Errorf("ram_gb = %#v, want this machine's %d", raw["ram_gb"], systemRAMGB())
	}
}

// The model step reads moe_min_vram and min_ram by name off /api/state.
func TestStateCarriesTheMoEAllowance(t *testing.T) {
	s := newTestServer(t)
	s.cat.Entries = append(s.cat.Entries, s.cat.Entries[0])
	s.cat.Entries[1].Index, s.cat.Entries[1].MinVRAM = 2, 18
	s.cat.Entries[1].MoEMinVRAM, s.cat.Entries[1].MinRAM = 8, 24

	rec := httptest.NewRecorder()
	s.routes().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	var st struct {
		Models []map[string]any `json:"models"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if len(st.Models) != 2 {
		t.Fatalf("models: %v", st.Models)
	}
	moe := st.Models[1]
	if moe["moe_min_vram"] != float64(8) || moe["min_ram"] != float64(24) || moe["min_vram"] != float64(18) {
		t.Errorf("MoE model = %v", moe)
	}
	if dense := st.Models[0]; dense["moe_min_vram"] != float64(0) || dense["min_ram"] != float64(0) {
		t.Errorf("dense model = %v, want zero allowance", dense)
	}
}
