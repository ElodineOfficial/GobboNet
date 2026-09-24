# Windows installer

This is the script that built `GobboNetSetup-1_7_0.exe` and everything before
it. It installs the batch/PowerShell path — `launch.bat` and `fileserver.ps1` —
and needs no Go binary.

```sh
# stage the payload next to this directory as ../staging, then:
makensis gobbonet.nsi
```

Only `!define APPVER` changes between releases. `OutFile` and
`VIProductVersion` track it.

## 1.7.6: the same installer, plus gobbonet.exe

Same pages, same first-run flow (`launch.bat` fetches llama.cpp and offers the
model catalogue on first launch); nothing is downloaded during setup. Three
additions, all forced by shipping the Go server:

- **`gobbonet.exe` is installed.** `launch.bat` hands the server role to it
  when present. `fileserver.ps1` alone has no per-conversation sync routes, so
  1.7.6's chat backup and device sync would fail without it.
- **GobboNet is stopped before files are replaced or removed**
  (`stop-gobbonet.bat /quiet`), because a running `gobbonet.exe` holds its own
  file open.
- **Uninstall runs `gobbonet uninstall --yes --keep-models`**, which removes
  the conversations and settings the Go server keeps in the user profile, then
  deletes `gobbonet.exe` and the `web\` folder it writes. Models are still the
  uninstaller's own question.

Staging for a build: copy into `../staging` the files the script lists
(`launch.bat`, the other `.bat`/`.ps1` helpers, `chat.html`,
`default-characters.json`, `LICENSE`, `TROUBLESHOOTING.md`, `SECURITY.md`,
`js/`, `css/`), plus `gobbonet.exe` from `make-zip.sh`, plus `PURGE.md` from
`docs/PURGE.md` (it moved there in 1.7.2; the install keeps it at the root,
where `TROUBLESHOOTING.md` points).

## Not to be confused with `installer/`

`installer/gobbonet.nsi` is a different, unreleased script for a Go-server
Windows install: it adds backend, GPU-probe and model-download pages, bundles
`gobbonet.exe` and llama.cpp, and downloads a model during setup behind an
`inetc /BANNER` popup. It has never shipped. Build from **this** directory
unless you are deliberately working on that one.

## art/

`art/modern-header.bmp` carries the version as painted pixels — `v1.7` covers
the whole 1.7.x line. It is not generated, so it does not follow `APPVER`; on a
minor bump the bitmap has to be repainted or the wizard shows the old number
while every other surface shows the new one. The copy under `installer/art/`
was stale at `v1.3` for exactly this reason and has been replaced with the
shipped one.
