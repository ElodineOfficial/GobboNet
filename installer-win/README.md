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
