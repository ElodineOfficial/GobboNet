package config

import "testing"

// launch.bat's managed path hands its GPU_LAYERS to gobbonet.exe with
// `gobbonet config set gpu_layers "!GPU_LAYERS!"`, output discarded. Its
// default is -1 (automatic placement), so a Set that refused -1 -- or wrote
// something Load reads differently -- would silently keep whatever the file
// held before, and automatic placement would never be switched on.
func TestSetRoundTripsAutomaticGPULayers(t *testing.T) {
	path := writeConfig(t, "llm_url = \"http://x:1\"\ngpu_layers = 99\n")
	if err := Set(path, "gpu_layers", "-1"); err != nil {
		t.Fatalf("Set refused automatic placement: %v", err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.GPULayers != -1 {
		t.Fatalf("gpu_layers = %d after setting -1", cfg.GPULayers)
	}
	if err := Set(path, "gpu_layers", "99"); err != nil {
		t.Fatal(err)
	}
	if cfg, err = Load(path); err != nil || cfg.GPULayers != 99 {
		t.Fatalf("an explicit count no longer round-trips: %d, %v", cfg.GPULayers, err)
	}
}
