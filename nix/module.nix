self: { config, lib, pkgs, ... }:

with lib;

let
  cfg = config.services.gobbonet;
  gobbonetPkg = if cfg.package != null then cfg.package else self.packages.${pkgs.system}.default;
in {
  options.services.gobbonet = {
    enable = mkEnableOption "GobboNet self-hosted AI chat frontend and server";

    package = mkOption {
      type = types.nullOr types.package;
      default = null;
      description = "The GobboNet package to use (defaults to flake package).";
    };

    llamaPackage = mkOption {
      type = types.nullOr types.package;
      default = pkgs.llama-cpp;
      description = "The llama.cpp package providing llama-server for local model inference.";
    };

    listenHost = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = "Address to bind to (use 127.0.0.1 for loopback, 0.0.0.0 for LAN access).";
    };

    listenPort = mkOption {
      type = types.port;
      default = 9066;
      description = "HTTP port to listen on.";
    };

    modelDir = mkOption {
      type = types.path;
      default = "/var/lib/gobbonet/models";
      description = "Directory containing GGUF model files.";
    };

    stateDir = mkOption {
      type = types.path;
      default = "/var/lib/gobbonet";
      description = "Directory where runtime state and settings are stored.";
    };

    searchUrl = mkOption {
      type = types.str;
      default = "https://ollama.com/api";
      description = "Web search relay or API endpoint.";
    };

    embedUrl = mkOption {
      type = types.str;
      default = "http://127.0.0.1:11436";
      description = "Embedding server URL for RAG.";
    };

    openFirewall = mkOption {
      type = types.bool;
      default = false;
      description = "Whether to automatically open the listenPort in the NixOS firewall.";
    };

    extraEnvironment = mkOption {
      type = types.attrsOf types.str;
      default = {};
      description = "Extra environment variables passed to the gobbonet service.";
    };
  };

  config = mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = mkIf cfg.openFirewall [ cfg.listenPort ];

    users.users.gobbonet = {
      isSystemUser = true;
      group = "gobbonet";
      home = cfg.stateDir;
      createHome = true;
    };

    users.groups.gobbonet = {};

    systemd.tmpfiles.rules = [
      "d '${cfg.stateDir}' 0750 gobbonet gobbonet - -"
      "d '${cfg.modelDir}' 0750 gobbonet gobbonet - -"
    ];

    systemd.services.gobbonet = {
      description = "GobboNet Local AI Chat Server";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];

      environment = {
        GOBBONET_LISTEN_HOST = cfg.listenHost;
        GOBBONET_LISTEN_PORT = toString cfg.listenPort;
        GOBBONET_MODEL_DIR = toString cfg.modelDir;
        GOBBONET_DATA_DIR = toString cfg.stateDir;
        GOBBONET_SEARCH_URL = cfg.searchUrl;
        GOBBONET_EMBED_URL = cfg.embedUrl;
      } // cfg.extraEnvironment;

      path = lib.optional (cfg.llamaPackage != null) cfg.llamaPackage;

      serviceConfig = {
        Type = "simple";
        User = "gobbonet";
        Group = "gobbonet";
        WorkingDirectory = cfg.stateDir;
        StateDirectory = "gobbonet";
        ExecStart = "${gobbonetPkg}/bin/gobbonet serve";
        Restart = "on-failure";
        RestartSec = "5s";

        # Security sandbox hardening
        ProtectSystem = "strict";
        ProtectHome = true;
        ReadWritePaths = [ cfg.stateDir cfg.modelDir ];
        PrivateTmp = true;
        PrivateDevices = false; # Allow GPU device access (/dev/dri, /dev/kfd, /dev/nvidia*)
        CapabilityBoundingSet = "";
        NoNewPrivileges = true;
      };
    };
  };
}
