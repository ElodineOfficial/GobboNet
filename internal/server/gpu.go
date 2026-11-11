package server

// GET/POST /gpu (1.8.0, issue #72): which GPU the engine uses.
//
// GET lists the devices the engine itself can see (llama-server
// --list-devices, run once per engine and cached: engine.ProbeDevices), what
// gpu_device says in config.toml and what the running supervisor will use,
// whether the PRIME switch is worth offering, and -- on Linux -- which engine
// build the launcher picked and why. POST saves gpu_device and
// gpu_prime_offload to config.toml and hands them to the supervisor for the
// next start; CONFIG > Performance then restarts the model through the swap
// path, as it does for the other launch arguments.
//
// Any signed-in device, as /perf: a device ID checked against the engine's own
// list, and a fixed pair of environment variables, run nothing. A page on
// another site cannot change it (sameOriginOrNone).

import (
	"encoding/json"
	"io"
	"log"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"

	"github.com/ElodineOfficial/GobboNet/internal/config"
	"github.com/ElodineOfficial/GobboNet/internal/engine"
	"github.com/ElodineOfficial/GobboNet/internal/httpx"
)

type gpuView struct {
	Remote       bool            `json:"remote,omitempty"`
	Devices      []engine.Device `json:"devices"`
	ProbeError   string          `json:"probe_error,omitempty"`
	Setting      string          `json:"gpu_device"`
	InUse        string          `json:"in_use"`
	Warning      string          `json:"warning,omitempty"`
	Prime        bool            `json:"gpu_prime_offload"`
	PrimeOffered bool            `json:"prime_offered"`
	Linux        bool            `json:"linux"`
	Build        string          `json:"engine_build,omitempty"`
	BuildReason  string          `json:"engine_build_reason,omitempty"`
	SmallCardMiB int             `json:"small_card_mib"`
}

// probeDevices is engine.ProbeDevices, replaceable in tests.
var probeDevices = engine.ProbeDevices

func (s *Server) gpuNow() gpuView {
	v := gpuView{Devices: []engine.Device{}, Linux: runtime.GOOS == "linux", SmallCardMiB: engine.SmallCardMiB}
	if s.sup == nil {
		v.Remote = true
		return v
	}
	devs, err := probeDevices(s.cfg.ServerExe)
	if err != nil {
		v.ProbeError = err.Error()
	} else if devs != nil {
		v.Devices = devs
	}
	v.Setting, v.Prime = s.cfg.GPUDevice, s.cfg.GPUPrimeOffload
	if s.cfg.Path != "" {
		if file, err := config.Load(s.cfg.Path); err == nil {
			v.Setting, v.Prime = file.GPUDevice, file.GPUPrimeOffload
		}
	}
	v.InUse, _ = s.sup.Device()
	if _, warning := engine.ResolveDevice(v.Setting, devs, err); warning != "" {
		v.Warning = warning
	}
	v.PrimeOffered = v.Linux && err == nil && engine.PrimeOffered(devs)
	if v.Linux {
		if raw, err := os.ReadFile(config.EngineChoicePath()); err == nil {
			c := engine.ParseEngineChoice(string(raw))
			v.Build, v.BuildReason = c.Build, c.Reason
		}
	}
	return v
}

func (s *Server) handleGPU(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		httpx.WriteJSON(w, r, http.StatusOK, s.gpuNow())
		return
	case http.MethodPost:
	default:
		httpx.Error(w, r, http.StatusMethodNotAllowed, "GET or POST only")
		return
	}
	if !sameOriginOrNone(r) {
		httpx.Error(w, r, http.StatusForbidden, "the GPU can only be chosen from GobboNet's own page")
		return
	}
	if s.sup == nil {
		httpx.Error(w, r, http.StatusConflict, "GobboNet does not run the model here (remote mode), so there is no GPU to choose")
		return
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<10))
	if err != nil {
		httpx.Error(w, r, http.StatusBadRequest, "could not read body")
		return
	}
	var in struct {
		Device *string `json:"gpu_device"`
		Prime  *bool   `json:"gpu_prime_offload"`
	}
	if json.Unmarshal(raw, &in) != nil || (in.Device == nil && in.Prime == nil) {
		httpx.Error(w, r, http.StatusBadRequest, `send {"gpu_device": "auto" | "none" | "<device ID>", "gpu_prime_offload": false}`)
		return
	}
	now := s.gpuNow()
	device, prime := now.Setting, now.Prime
	if in.Device != nil {
		device = strings.TrimSpace(*in.Device)
		if device == "" {
			device = "auto"
		}
		if !engine.ValidDeviceSetting(device) {
			httpx.Error(w, r, http.StatusBadRequest, `gpu_device is "auto", "none", or device IDs as the engine lists them`)
			return
		}
	}
	if in.Prime != nil {
		prime = *in.Prime
	}
	if prime && runtime.GOOS != "linux" {
		httpx.Error(w, r, http.StatusBadRequest, "PRIME offload is a Linux setting")
		return
	}
	devs, perr := probeDevices(s.cfg.ServerExe)
	arg, warning := engine.ResolveDevice(device, devs, perr)
	if warning != "" {
		httpx.Error(w, r, http.StatusBadRequest, warning)
		return
	}
	if s.cfg.Path == "" {
		httpx.Error(w, r, http.StatusConflict, "this server was started without a config file, so there is nowhere to save the choice")
		return
	}
	for _, kv := range [][2]string{{"gpu_device", device}, {"gpu_prime_offload", strconv.FormatBool(prime)}} {
		if err := config.Set(s.cfg.Path, kv[0], kv[1]); err != nil {
			log.Printf("[gpu] could not save %s to %s: %v", kv[0], s.cfg.Path, err)
			httpx.Error(w, r, http.StatusInternalServerError, "config.toml could not be written, so the GPU choice was not changed")
			return
		}
	}
	s.sup.SetDevice(arg, prime && runtime.GOOS == "linux")
	log.Printf("[gpu] gpu_device = %s, gpu_prime_offload = %v; applies from the next model start", device, prime)
	httpx.WriteJSON(w, r, http.StatusOK, s.gpuNow())
}
