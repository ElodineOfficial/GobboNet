# GobboNet 1.7.3 — Linux packaging repair

## Confirmed defect

The supplied revision-1 DEB has `/usr/lib/gobbonet/web` at mode 0700, owned by
root. Its public assets therefore cannot be read by a regular user.
`stage-web.sh` uses `mktemp -d` and renames the temporary directory into `web/`;
0700 comes from mktemp itself, even with umask 0022.

The supplied source already has a broad `chmod -R a+rX` in its DEB builder,
which should have repaired that directory. Thus the defective DEB does not
establish that this exact source/build sequence produced it. The changes below
fix web staging at its source and enforce the final package contract explicitly.

## Changes

- Normalize generated web directories to 0755 and web files to 0644.
- Add a final package permissions helper and required-executable checks.
- Advance Debian revision from 1 to 2 while keeping application version 1.7.3.
- Declare libstdc++6 >= 12, libgcc-s1, libgomp1 and libssl3t64 or libssl3 >= 3.0.0,
  in addition to the existing libc6 and xdg-utils dependencies. These correspond
  to dependencies visible in the supplied engine ELF files. The highest required
  GLIBC version remains 2.34; the Vulkan library requires GLIBCXX_3.4.30.
- Add executable regression tests for umask 0022/0077, restrictive source asset
  modes, restrictive staging ancestors, and rejection of a missing launcher.

## Returned DEB provenance

Repacked directly from the supplied revision-1 DEB, using the new permissions
helper and updated control metadata. Every one of its 105 regular payload files
under `/usr` is byte-identical to the supplied package, including the application,
engine libraries, launch scripts and frontend. Symlink targets are unchanged.
This is a packaging repair, not a newly compiled Go build. The Windows installer
and application behavior were not modified.

## Verification completed

- Regression tests pass for both umasks and the missing-launcher negative case.
- Changed shell scripts pass Bash syntax checks.
- Re-extracted the finished DEB into a new directory: all public directories are
  0755 and all public regular files are readable by all users.
- Verified all payload bytes and symlink targets against the original DEB.
- Debian version comparison confirms revision 2 upgrades revision 1.
- Started the packaged Go server outside the source tree with a temporary,
  loopback-only, unauthenticated remote-mode test configuration. HTML, CSS, JS,
  presets and favicon returned HTTP 200 with the expected bytes.
- Started the packaged first-run setup with the supplied model catalogue and
  verified that its browser wizard returns HTML successfully.
- The supplied engine reports build 10456 with its library directory explicitly
  supplied through LD_LIBRARY_PATH for this sandbox test. The binary has an
  $ORIGIN RUNPATH; normal installed-path resolution was not tested here.

## Remaining machine-level verification

This sandbox cannot switch UID, so a real non-root execution test was blocked.
The server and wizard smoke tests ran as the sandbox's root identity and do not
substitute for that test. No system-wide apt install/purge, 1.7.2 upgrade,
graphical desktop launch, Windows EXE execution, GPU/model inference, or fresh
source compilation was performed. No model was downloaded. Use a disposable
Debian/Ubuntu desktop to finish those checks before distributing broadly.

## Installing the repair

Run in the directory containing the returned DEB:

```sh
sudo apt install ./gobbonet_1.7.3+go.nogit.20260908-2_amd64.deb
```

Do not purge first. Then launch GobboNet from the applications menu as your
normal user; that entry runs first-run setup and opens the browser. Terminal
users can run `gobbonet setup`, then `gobbonet --open` after setup completes.
Existing config, models and conversations are left in place.
