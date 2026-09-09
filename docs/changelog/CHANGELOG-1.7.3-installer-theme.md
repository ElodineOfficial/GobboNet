# v1.7.3 — the installer got its theme back

*Found while preparing the 1.7.3 packaging, by diffing the shipped
`GobboNetSetup-1_7_0.exe` source against `installer/gobbonet.nsi` in the tree.*

---

## What happened

The Go rewrite replaced the installer wholesale. The new one is genuinely
better — it probes the GPU, offers a backend choice, picks a model during
install and verifies its hash — but it was rebuilt from the page flow up, and
the theme layer did not come with it.

The artwork survived, which is what made this hard to spot: `gobbonet.ico`,
`modern-header.bmp` and `modern-wizard.bmp` are all still referenced and still
render. What went missing is every colour around them.

```
SetCtlColors calls   1.7.0: 53      in-tree before this change: 0
```

Concretely, the in-tree installer would have shipped with:

| Lost | Effect |
|---|---|
| `MUI_BGCOLOR` / `MUI_TEXTCOLOR` | welcome and finish pages fall back to system colours |
| `StyleParentWindow` / `un.StyleParentWindow` | **the parent window is never painted** — Windows grey behind every page and the whole button row |
| `InstallColors` | the install log is a white listbox instead of green on black |
| `BrandingText` | no footer credit |
| `MUI_HEADERIMAGE_RIGHT` | header art on the wrong side |
| `MUI_HEADERIMAGE_UNBITMAP`, `MUI_UNWELCOMEFINISHPAGE_BITMAP` | uninstaller carries no art at all |
| `MUI_UNPAGE_WELCOME`, `MUI_UNPAGE_FINISH` | uninstaller has no welcome or finish page |
| `DefenderPageCreate` | see below |

The parent-window one is the worst of them. MUI paints the header strip and the
welcome/finish bodies and nothing else, so without `StyleParentWindow` the
wizard is dark at the top, dark on the first and last screens, and system grey
everywhere in between — which looks less like a theme and more like a broken
one.

## The Defender page

1.7.0 carried a full page explaining that GobboNet's shape — large download,
several local servers, scripts running from a user-profile folder — is what
Defender reads, and walking the user through adding a folder exclusion. It was
positioned deliberately:

> *Sits between the install and the finish page on purpose: it has to be read
> BEFORE the Launch GobboNet checkbox, because the first launch is exactly when
> Defender is most likely to interfere.*

The in-tree installer does not mention Defender anywhere — `grep -ci defender`
returned 0 — while `SECURITY.md` is largely about this exact problem. Restored,
in the same slot, with the install path filled in so the user can read the
folder to exclude off the screen.

## Restored

Everything in the table above, plus per-control colours for the four custom
pages the Go installer added — Backend, Probe, Model, Finish — which 1.7.0
never had and so had no theming to inherit. A custom page is a bare system
dialog; every control has to be coloured individually.

Radio buttons and checkboxes get `uxtheme::SetWindowTheme` called on them first.
`SetCtlColors` paints the background, but a *themed* button draws its own label
with `DrawThemeText` and ignores the foreground colour, so it has to be detached
from the visual style or the label stays black on near-black. That is 1.7.0's
trick, and it is still required.

Two new tokens were added rather than repeating literals: `GN_FIELDFG` /
`GN_FIELDBG` for edit and list controls, and `GN_DIMTEXT` for secondary lines.
1.7.0 spelled `F2FAE8`, `1A1D25` and `8FA383` inline in a dozen places; the
values are unchanged.

## Verified

Compiled with **NSIS 3.09** — the version `build-installer.sh` pins, so no
mismatch note — against a payload assembled from the real tree:

```
makensis -V2 -DVERSION=1.7.3 -DVERSION_QUAD=1.7.3.0 -DPAYLOAD=... gobbonet.nsi
→ 0 errors, 0 warnings, GobboNetSetup-1.7.3.exe (772,678 bytes)
```

For comparison, the shipped `GobboNetSetup-1_7_0.exe` is 771,471 bytes — the
theme costs about 1 KB.

Nothing about the install *behaviour* changed. No `File` directive, section,
registry write or shortcut was touched; the diff is colours, four `Function`
blocks, three page hooks and one restored page.

## Note

`build-installer.sh` already takes `VERSION` and `VERSION_QUAD` from the
`VERSION` file and passes them with `-D`, so there is no version literal in the
`.nsi` to keep in sync. Bumping `VERSION` to `1.7.3` was the whole of it.

---

## Corrections after first test build

Two things reported against the first Go-era 1.7.3 installer, both mine.

**A stale `v1.3` under the wordmark.** It is painted into
`installer/art/modern-header.bmp`, not written by the script — the header strip
is a bitmap, so the version in it was frozen at whatever release the art was cut
for. Enabling `MUI_HEADERIMAGE_RIGHT` moved that strip to the top right, which
is where it got noticed.

Removed from the art rather than repainted to say 1.7.3, because a number baked
into a bitmap goes stale again on the next release and nothing in the build
would catch it. The version already appears in three places the script fills
from `${VERSION}`: the branding strip, the welcome page title, and the registry
`DisplayVersion`. 52 pixels cleared, in a box the surrounding rows show is
plain background; the goblin, the wordmark, the speckles and the border rule are
untouched.

**An extra page after the install.** The restored Defender notice sat between
`MUI_PAGE_INSTFILES` and the finish page. It stalled there, and it arrived
directly after the model download, which is a bad place to interrupt someone.
Removed — page and function both.

The uninstaller welcome and finish pages went with it. They were in the 1.7.0
installer so restoring them looked defensible, but they are still two screens
that were not in the Go-era page set, which is the same thing the Defender page
was. `MUI_UNWELCOMEFINISHPAGE_BITMAP` went too, since nothing displays it now.

The installer diff against the pre-theming script is now colours, the six
theming functions and the header-image position. No page added, none removed,
no `File`, `Section`, registry write or shortcut touched.

---

## The model-download popup

Reported as a popup during the model download that the old installer did not
have. It is `inetc::get /BANNER`, and it is in the Go-era script as originally
written — not something the theme introduced. Checked by diffing against the
pre-theming copy: **174 lines added, 0 removed**, and the `inetc::get` call was
byte-identical on both sides.

`/BANNER` opens a floating window over the wizard for the length of the
download. On a multi-GB model that is the longest and least interruptible part
of the install, and the banner covers the details pane that is reporting what is
happening. Removed, along with `/CAPTION`, which only ever set that window's
title. Without them inetc drives the InstFiles progress bar and status line
instead, so the download reads as part of the install rather than as something
that interrupted it. The two `DetailPrint` lines above the call already name the
model and its size.

The reason it never showed up before is that the 1.7.0 installer had no model
download step at all — no backend, probe or model page. Comparing the two, this
is a page the Go-era installer added, not a regression in an existing one.

The second `inetc::get`, which fetches the LFS checksum pointer, already used
`/SILENT` and is untouched.
