{ pkgs ? import <nixpkgs> { config.allowUnfree = true; } }:

pkgs.mkShell {
  packages = [
    pkgs.go
    pkgs.gopls
    pkgs.golangci-lint
    pkgs.llama-cpp
  ];
}
