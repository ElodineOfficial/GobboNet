package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/engine"
	"github.com/ElodineOfficial/GobboNet/internal/supervisor"
)

// /gpu (1.8.0, #72).

var hybrid = []engine.Device{
	{ID: "Vulkan0", Name: "Intel(R) HD Graphics 620", TotalMiB: 7834, Integrated: true},
	{ID: "Vulkan1", Name: "NVIDIA GeForce 940MX", TotalMiB: 2048},
}

func gpuServer(t *testing.T, devs []engine.Device, probeErr error) (*Server, config.Config) {
	t.Helper()
	srv, cfg := newTestServer(t)
	sup, err := supervisor.New(supervisor.Options{ModelDir: cfg.ModelDir, LLMURL: "http://127.0.0.1:1"})
	if err != nil {
		t.Fatal(err)
	}
	srv.sup = sup
	old := probeDevices
	probeDevices = func(string) ([]engine.Device, error) { return devs, probeErr }
	t.Cleanup(func() { probeDevices = old })
	return srv, cfg
}

func gpuGet(t *testing.T, srv *Server) gpuView {
	t.Helper()
	var v gpuView
	if err := json.Unmarshal(do(t, srv, http.MethodGet, "/gpu", nil).Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGPUListsTheEnginesDevices(t *testing.T) {
	srv, _ := gpuServer(t, hybrid, nil)
	v := gpuGet(t, srv)
	if len(v.Devices) != 2 || v.Devices[1].ID != "Vulkan1" || v.Setting != "auto" || v.InUse != "" || v.SmallCardMiB != 3072 {
		t.Errorf("GET /gpu = %+v", v)
	}
	if v.PrimeOffered {
		t.Error("PRIME offered with a dedicated GPU in the list")
	}
}

func TestGPUSaveWritesConfigAndTheNextStart(t *testing.T) {
	srv, cfg := gpuServer(t, hybrid, nil)
	rec := do(t, srv, http.MethodPost, "/gpu", strings.NewReader(`{"gpu_device":"vulkan1"}`))
	if rec.Code != http.StatusOK {
		t.Fatalf("POST: %d %s", rec.Code, rec.Body.String())
	}
	file, _ := config.Load(cfg.Path)
	if file.GPUDevice != "vulkan1" {
		t.Errorf("config.toml gpu_device = %q", file.GPUDevice)
	}
	if dev, _ := srv.sup.Device(); dev != "Vulkan1" {
		t.Errorf("the next start will use %q, want the engine's spelling, Vulkan1", dev)
	}
	do(t, srv, http.MethodPost, "/gpu", strings.NewReader(`{"gpu_device":"auto"}`))
	if dev, _ := srv.sup.Device(); dev != "" {
		t.Errorf("auto left --device %q", dev)
	}
}

func TestGPURefusesWhatTheEngineCannotUse(t *testing.T) {
	srv, cfg := gpuServer(t, hybrid, nil)
	before := gpuGet(t, srv).Setting
	for _, body := range []string{`{"gpu_device":"CUDA0"}`, `{"gpu_device":"Vulkan0; rm -rf /"}`, `{"gpu_device":"--model x"}`, `{}`, `nope`} {
		if rec := do(t, srv, http.MethodPost, "/gpu", strings.NewReader(body)); rec.Code != http.StatusBadRequest {
			t.Errorf("POST %s: %d, want 400", body, rec.Code)
		}
	}
	if file, _ := config.Load(cfg.Path); file.GPUDevice != before {
		t.Errorf("a refused choice reached config.toml: %q", file.GPUDevice)
	}
	if runtime.GOOS != "linux" {
		if rec := do(t, srv, http.MethodPost, "/gpu", strings.NewReader(`{"gpu_prime_offload":true}`)); rec.Code != http.StatusBadRequest {
			t.Errorf("PRIME off Linux: %d", rec.Code)
		}
	}
	req := newReq(http.MethodPost, "/gpu", strings.NewReader(`{"gpu_device":"auto"}`))
	req.Header.Set("Origin", "https://elsewhere.example")
	w := httptest.NewRecorder()
	srv.ServeHTTP(w, req)
	if w.Code != http.StatusForbidden {
		t.Errorf("cross-site POST: %d", w.Code)
	}

	stuck, _ := gpuServer(t, nil, errors.New("the engine took too long"))
	if rec := do(t, stuck, http.MethodPost, "/gpu", strings.NewReader(`{"gpu_device":"Vulkan1"}`)); rec.Code != http.StatusBadRequest {
		t.Errorf("a device that cannot be checked: %d, want 400", rec.Code)
	}
	if v := gpuGet(t, stuck); v.ProbeError == "" {
		t.Error("GET does not say the devices could not be listed")
	}
}

func TestGPUPrimeIsOfferedOnlyForAnIntegratedOnlyList(t *testing.T) {
	srv, _ := gpuServer(t, hybrid[:1], nil)
	v := gpuGet(t, srv)
	if v.PrimeOffered != (runtime.GOOS == "linux") {
		t.Errorf("prime_offered = %v on %s with only an integrated GPU", v.PrimeOffered, runtime.GOOS)
	}
	if runtime.GOOS == "linux" {
		if rec := do(t, srv, http.MethodPost, "/gpu", strings.NewReader(`{"gpu_prime_offload":true}`)); rec.Code != http.StatusOK {
			t.Fatalf("POST prime: %d %s", rec.Code, rec.Body.String())
		}
		if _, prime := srv.sup.Device(); !prime {
			t.Error("the next start will not get the PRIME pair")
		}
	}
}

func TestGPUInRemoteMode(t *testing.T) {
	srv, _ := newTestServer(t)
	if v := gpuGet(t, srv); !v.Remote {
		t.Errorf("remote mode: %+v", v)
	}
	if rec := do(t, srv, http.MethodPost, "/gpu", strings.NewReader(`{"gpu_device":"auto"}`)); rec.Code != http.StatusConflict {
		t.Errorf("POST in remote mode: %d", rec.Code)
	}
}
