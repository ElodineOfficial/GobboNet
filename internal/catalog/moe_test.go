package catalog

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Issue #65: a Mixture-of-Experts model fits a smaller card when system RAM
// holds the experts that do not fit on it.

func TestFitsCoversBothRules(t *testing.T) {
	moe := Entry{MinVRAM: 18, MoEMinVRAM: 8, MinRAM: 24}
	dense := Entry{MinVRAM: 10}
	cases := []struct {
		name      string
		e         Entry
		vram, ram int
		want      bool
	}{
		{"MoE on a big card", moe, 24, 8, true},
		{"MoE on 8 GB with 32 GB RAM", moe, 8, 32, true},
		{"MoE on 8 GB with exactly 24 GB RAM", moe, 8, 24, true},
		{"MoE on 8 GB with 16 GB RAM", moe, 8, 16, false},
		{"MoE on 6 GB with 64 GB RAM", moe, 6, 64, false},
		{"MoE with RAM unknown", moe, 8, 0, false},
		{"MoE with no GPU", moe, 0, 64, false},
		{"dense on a big card", dense, 12, 0, true},
		{"dense on a small card, lots of RAM", dense, 8, 128, false},
		{"dense with no GPU", dense, 0, 64, false},
		// An entry with a MinVRAM of 0 is not a free pass on a machine with
		// no GPU figure at all: unknown confirms nothing.
		{"unknown VRAM", Entry{}, 0, 0, false},
	}
	for _, c := range cases {
		if got := c.e.Fits(c.vram, c.ram); got != c.want {
			t.Errorf("%s: Fits(%d, %d) = %v, want %v", c.name, c.vram, c.ram, got, c.want)
		}
	}
}

func TestLoadReadsTheMoEAllowance(t *testing.T) {
	c, err := Load(write(t, "[1]\r\ndisplay=M\r\nrepo=o/r\r\nfile=m.gguf\r\nmin_vram=18\r\n"+
		"moe_min_vram=8\r\nmin_ram=24\r\n\r\n[2]\r\ndisplay=D\r\nrepo=o/r\r\nfile=d.gguf\r\nmin_vram=8\r\n"))
	if err != nil {
		t.Fatal(err)
	}
	if m, _ := c.Find(1); m.MoEMinVRAM != 8 || m.MinRAM != 24 || m.MinVRAM != 18 {
		t.Errorf("MoE entry: %+v", m)
	}
	if d, _ := c.Find(2); d.MoEMinVRAM != 0 || d.MinRAM != 0 {
		t.Errorf("dense entry has an allowance: %+v", d)
	}
}

// The shipped list: every MoE model carries an allowance, the allowance is a
// smaller card than the whole model needs, and the RAM it asks for can hold
// the whole download -- experts that leave the card have to live somewhere.
func TestShippedMoEModelsCarryASaneAllowance(t *testing.T) {
	c, err := Load(bundledINI)
	if err != nil {
		t.Skip("catalog/models.ini not present")
	}
	want := map[string]bool{
		"google_gemma-4-26B-A4B-it-Q4_K_S.gguf":    true,
		"Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf":         true,
		"gpt-oss-20b-MXFP4.gguf":                   true,
		"Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf": true,
	}
	got := 0
	for _, e := range c.Entries {
		has := e.MoEMinVRAM > 0 && e.MinRAM > 0
		if has != want[e.File] {
			t.Errorf("%s: allowance %d/%d, MoE=%v", e.Display, e.MoEMinVRAM, e.MinRAM, want[e.File])
			continue
		}
		if !has {
			continue
		}
		got++
		if e.MoEMinVRAM >= e.MinVRAM {
			t.Errorf("%s: MoE card %d GB is not smaller than the whole-model %d GB", e.Display, e.MoEMinVRAM, e.MinVRAM)
		}
		if float64(e.MinRAM) < e.SizeGB {
			t.Errorf("%s: %d GB RAM cannot hold a %.0f GB model", e.Display, e.MinRAM, e.SizeGB)
		}
	}
	if got != len(want) {
		t.Errorf("%d MoE models carry an allowance, want %d", got, len(want))
	}
}

func TestParseRemoteReadsTheMoEAllowance(t *testing.T) {
	body := `{"schema_version":1,"models":[
		{"index":1,"display":"M","repo":"r/m","file":"m.gguf","min_vram_gb":18,"moe_min_vram_gb":8,"min_ram_gb":24},
		{"index":2,"display":"D","repo":"r/d","file":"d.gguf","min_vram_gb":8}
	]}`
	c, err := ParseRemote([]byte(body), "1.7.7")
	if err != nil {
		t.Fatal(err)
	}
	if m, _ := c.Find(1); m.MoEMinVRAM != 8 || m.MinRAM != 24 {
		t.Errorf("MoE entry: %+v", m)
	}
	if d, _ := c.Find(2); d.MoEMinVRAM != 0 || d.MinRAM != 0 {
		t.Errorf("dense entry: %+v", d)
	}
}

func TestTheLiveListBorrowsTheMoEAllowance(t *testing.T) {
	bundled, err := Load(bundledINI)
	if err != nil {
		t.Skip("catalog/models.ini not present")
	}
	live := &Catalog{Entries: []Entry{
		{Index: 5, File: "google_gemma-4-26B-A4B-it-Q4_K_S.gguf", MinVRAM: 16},
		// The live list has its own opinion here and keeps it.
		{Index: 6, File: "Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf", MinVRAM: 24, MoEMinVRAM: 12, MinRAM: 48},
		{Index: 7, File: "not-in-the-bundled-list.gguf", MinVRAM: 10},
		{Index: 2, File: "Llama-3.2-3B-Instruct-Q8_0.gguf", MinVRAM: 4},
	}}
	if n := borrowMoE(live, bundled); n != 1 {
		t.Errorf("filled %d, want 1", n)
	}
	if e := live.Entries[0]; e.MoEMinVRAM != 8 || e.MinRAM != 24 {
		t.Errorf("Gemma MoE: %+v", e)
	}
	if e := live.Entries[1]; e.MoEMinVRAM != 12 || e.MinRAM != 48 {
		t.Errorf("a live allowance was overwritten: %+v", e)
	}
	for _, e := range live.Entries[2:] {
		if e.MoEMinVRAM != 0 || e.MinRAM != 0 {
			t.Errorf("%s was given an allowance: %+v", e.File, e)
		}
	}
}

// Through Fetch, as the Add a Model window sees it: the cached live list --
// which publishes no allowance -- comes back with the three MoE models filled.
func TestFetchFillsTheMoEAllowanceFromTheBundledList(t *testing.T) {
	dir := t.TempDir()
	body, _ := os.ReadFile(filepath.Join("testdata", "live-catalog.json"))
	cache, _ := json.Marshal(cacheFile{FetchedAt: time.Now(), Body: string(body)})
	if err := os.WriteFile(filepath.Join(dir, cacheName), cache, 0o600); err != nil {
		t.Fatal(err)
	}
	c, notes, err := Fetch(Options{Enabled: false, CacheDir: dir, ClientVersion: "1.7.7", BundledPath: bundledINI})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, e := range c.Entries {
		if e.MoEMinVRAM > 0 && e.MinRAM > 0 {
			n++
		}
	}
	if n != 3 {
		t.Errorf("%d models carry an allowance, want 3", n)
	}
	if !strings.Contains(strings.Join(notes, "\n"), "MoE small-card allowance for 3 model(s)") {
		t.Errorf("notes: %v", notes)
	}
}
