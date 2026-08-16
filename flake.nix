{
  description = "Open Dev Container – VS Code extension: attach to running Docker/Podman containers via Remote SSH";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    let
      overlay = final: prev: {
        open-dev-container = final.callPackage ./nix/package.nix { };
      };
    in
    {
      overlays.default = overlay;
    }
    // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; overlays = [ overlay ]; };
      in
      {
        packages = {
          default = pkgs.open-dev-container;
          open-dev-container = pkgs.open-dev-container;
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.nodejs pkgs.typescript ];
        };
      });
}
