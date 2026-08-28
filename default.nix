{ pkgs ? import <nixpkgs> { config.allowUnfree = true; } }:

let
  version = builtins.replaceStrings [ "\n" "\r" " " ] [ "" "" "" ] (builtins.readFile ./VERSION);
in pkgs.buildGoModule {
  pname = "gobbonet";
  inherit version;
  src = ./.;

  preBuild = ''
    patchShebangs stage-web.sh
    ./stage-web.sh
  '';

  ldflags = [
    "-s"
    "-w"
    "-X github.com/jmccardle/gobbonet/internal/version.Version=${version}-nix"
  ];

  subPackages = [ "cmd/gobbonet" ];

  vendorHash = "sha256-xYZnna0cb9u1xk9eL1Tb4zII7mw+c5lF+TqaZDTr6E0=";

  meta = with pkgs.lib; {
    description = "Offline, self-hosted AI chat frontend and server for local GGUF models";
    homepage = "https://github.com/sam-henry-dev/gobbonet-arch";
    license = licenses.mit;
    mainProgram = "gobbonet";
    platforms = platforms.unix;
  };
}
