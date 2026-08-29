{
  description = "GobboNet: Offline, self-hosted AI chat frontend and server for local GGUF models";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs supportedSystems (system: f (import nixpkgs {
        inherit system;
        config = {
          allowUnfree = true;
        };
      }));
    in {
      packages = forAllSystems (pkgs:
        let
          version = builtins.replaceStrings [ "\n" "\r" " " ] [ "" "" "" ] (builtins.readFile ./VERSION);
          gobbonet = pkgs.buildGoModule {
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
          };

          gobbonet-with-llama = pkgs.symlinkJoin {
            name = "gobbonet-with-llama-${version}";
            paths = [ gobbonet pkgs.llama-cpp ];
            meta = gobbonet.meta;
          };
        in {
          default = gobbonet;
          inherit gobbonet gobbonet-with-llama;
        }
      );

      apps = forAllSystems (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.system}.default}/bin/gobbonet";
        };
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.go
            pkgs.gopls
            pkgs.golangci-lint
            pkgs.llama-cpp
          ];
        };
      });

      nixosModules = {
        default = self.nixosModules.gobbonet;
        gobbonet = import ./nix/module.nix self;
      };
    };
}
