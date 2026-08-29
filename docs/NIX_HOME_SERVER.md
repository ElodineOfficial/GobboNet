# GobboNet on Nix & Offline Home Server Guide

> **Sovereign, air-gapped AI on your local hardware.** Run GobboNet as a permanent home server or headless daemon with zero internet access, serving full-speed AI chat and system controls to your phone and local devices over your home LAN.

---

## 🏛️ The Architecture: Air-Gapped Host + LAN Phone Interface

```
┌─────────────────────────────────────────────────────────────┐
│                  Local Network (Home Wi-Fi)                 │
│                                                             │
│   📱 Phone / Tablet / Laptop                                │
│   Browser / PWA @ http://192.168.1.100:9066                 │
│   ├── Streaming token chat                                  │
│   ├── Character cards & personas                            │
│   ├── Model hot-swapping from bed/couch                     │
│   ├── Live hardware tuning (/perf)                          │
│   └── Background detached generation jobs                   │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTP over LAN (Port 9066)
                               │ Authenticated via Argon2id
┌──────────────────────────────▼──────────────────────────────┐
│  🖥️ Host PC / NixOS Home Server (Zero Internet Required)   │
│                                                             │
│   systemd service: services.gobbonet                        │
│   ├── GobboNet Go Server (Port 9066)                        │
│   │   ├── Embedded zero-build web assets (web/)             │
│   │   ├── Session & password security manager               │
│   │   ├── State sync database (state.json)                  │
│   │   └── Detached jobs in-memory manager                   │
│   │                                                         │
│   └── llama-server (Managed process or loopback :11437)     │
│       ├── Local GGUF models (/var/lib/gobbonet/models)      │
│       └── Hardware Acceleration (CUDA / ROCm / Vulkan)      │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 Quickstart with Nix

### 1. Run Instantly (No Installation)
Run GobboNet with your local `llama-server`:
```bash
nix run github:sam-henry-dev/gobbonet-arch
```

### 2. Enter Development Environment
Drop into a reproducible shell with Go, gopls, and llama.cpp ready:
```bash
nix develop
# or with classic nix:
nix-shell
```

### 3. Build the Package
```bash
nix build .#gobbonet
./result/bin/gobbonet serve --host 0.0.0.0 --port 9066
```

---

## 🏠 NixOS Service Module Configuration

Add GobboNet to your NixOS `configuration.nix` or flake-based system config:

### Basic Offline LAN Server

```nix
{ config, pkgs, inputs, ... }:

{
  imports = [
    inputs.gobbonet.nixosModules.default
  ];

  services.gobbonet = {
    enable = true;
    listenHost = "0.0.0.0";      # Listen on all network interfaces for LAN access
    listenPort = 9066;           # Default GobboNet port
    openFirewall = true;         # Automatically opens TCP 9066 in iptables/nftables
    modelDir = "/var/lib/gobbonet/models";
    stateDir = "/var/lib/gobbonet";

    # Zero internet access: empty search URL
    searchUrl = "";
  };
}
```

---

## ⚡ Hardware Acceleration Recipes for NixOS

NixOS makes compiling or running `llama.cpp` with exact GPU drivers declarative and effortless:

### 1. NVIDIA (CUDA)
```nix
services.gobbonet = {
  enable = true;
  listenHost = "0.0.0.0";
  openFirewall = true;
  
  # Override llamaPackage with CUDA support enabled
  llamaPackage = pkgs.llama-cpp.override {
    cudaSupport = true;
  };
};

# Ensure NVIDIA drivers are loaded
hardware.nvidia = {
  modesetting.enable = true;
  powerManagement.enable = true;
};
nixpkgs.config.allowUnfree = true;
```

### 2. AMD (ROCm / HIP)
```nix
services.gobbonet = {
  enable = true;
  listenHost = "0.0.0.0";
  openFirewall = true;
  
  # Override llamaPackage with ROCm support enabled
  llamaPackage = pkgs.llama-cpp.override {
    rocmSupport = true;
  };
};

# Allow access to GPU devices
hardware.amdgpu.opencl.enable = true;
```

### 3. Intel / AMD / Generic (Vulkan)
```nix
services.gobbonet = {
  enable = true;
  listenHost = "0.0.0.0";
  openFirewall = true;
  
  # Vulkan backend works across all modern GPUs
  llamaPackage = pkgs.llama-cpp.override {
    vulkanSupport = true;
  };
};
```

---

## 📱 Phone Remote Control & In-Bed / On-Couch Capabilities

When connected from your phone at `http://<server-ip>:9066`:

1. **Model Hot-Swapping (`/swap-model`)**:
   - Access the top-level model selector from your phone.
   - Switch between coding, creative, roleplay, or reasoning GGUFs on the fly without touching the host PC.
2. **Dynamic Hardware Tuning (`/perf`)**:
   - Tune context window (e.g. 4k vs 16k tokens) and GPU offload layers (0 to 99) directly in the UI.
   - Saves settings and automatically reinitializes the engine with the new parameters.
3. **Detached Generation Jobs (`/llm/jobs`)**:
   - Send complex, long-running prompts or story simulations to your PC from your phone.
   - Turn off your phone screen or leave the room. The PC generates tokens in RAM at 100–200 tok/s.
   - Reconnect anytime to retrieve the completed stream.
4. **Automated Scheduler & Cron**:
   - Set recurring prompts and reminders that execute locally on the host machine.
5. **Cross-Device Chat & State Sync (`/state`)**:
   - Conversations, folder hierarchies, and custom personas are synchronized across all connected devices.

---

## 🔒 Security & Air-Gap Invariants

- **Argon2id Password Security**: Protects access when binding to `0.0.0.0`. Unauthorized LAN devices cannot read chat history or trigger model runs.
- **Systemd Hardening**:
  - `ProtectSystem = "strict"`
  - `ProtectHome = true`
  - `ReadWritePaths = [ "/var/lib/gobbonet" ]`
  - `PrivateTmp = true`
  - `CapabilityBoundingSet = ""`
- **Zero Cloud Leakage**:
  - Web UI is 100% self-contained with no external CDNs, fonts, or analytics.
  - When `search_url = ""` or unconfigured, zero external network sockets are opened.
