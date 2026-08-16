# VS Code extension derivation for Open Dev Container.
#
# Compiles src/ with tsc (via buildNpmPackage) and wraps the result with
# vscode-utils.buildVscodeExtension so it can be used in
#   programs.vscode.profiles.default.extensions  (home-manager)
#   vscode-with-extensions                       (nixpkgs)
{ lib
, buildNpmPackage
, importNpmLock
, vscode-utils
}:
let
  manifest = lib.importJSON ../package.json;
  inherit (manifest) name version publisher;

  compiled = buildNpmPackage {
    pname = "${name}-compiled";
    inherit version;

    src = lib.cleanSourceWith {
      src = ../.;
      filter = path: type:
        let base = baseNameOf path; in
        !(lib.elem base [ "node_modules" "out" "dist" ".git" "result" "nix" "flake.nix" "flake.lock" ]);
    };

    # No hash needed: dependencies are fetched straight from package-lock.json.
    npmDeps = importNpmLock { npmRoot = ../.; };
    npmConfigHook = importNpmLock.npmConfigHook;

    # sharp (native, dev-only) is not needed to compile the extension.
    npmFlags = [ "--ignore-scripts" ];
    dontNpmRebuild = true;

    npmBuildScript = "compile";

    # Only ship what a .vsix would contain (see .vscodeignore).
    installPhase = ''
      runHook preInstall
      # buildVscodeExtension expects the .vsix layout: everything under extension/
      mkdir -p $out/extension
      cp -r package.json out resources LICENSE README.md $out/extension/
      runHook postInstall
    '';
  };
in
vscode-utils.buildVscodeExtension {
  pname = name;
  inherit version;
  # Hand over the sub-directory, not the whole output: stdenv copies a
  # directory src into the sandbox as ./extension (buildVscodeExtension's
  # default sourceRoot) and chmods the copy. Pointing sourceRoot at the store
  # path directly fails on a real NixOS store (read-only).
  src = "${compiled}/extension";

  vscodeExtPublisher = publisher;
  vscodeExtName = name;
  vscodeExtUniqueId = "${publisher}.${name}";

  meta = with lib; {
    description = manifest.description;
    homepage = "https://github.com/int3hh/open-dev-container";
    license = licenses.mit;
    platforms = platforms.all;
  };
}
