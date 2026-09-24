# 1.7.6 — Fedora RPM: Fedora 45, and a package that checks itself

The Fedora package as it stood for 1.7.6 built, and would have installed on
Fedora 45 — and there it would have had no engine. That is the headline. The
rest is the builder catching up with the Debian one, and a check that makes the
last three Fedora bugs impossible to ship again.

Everything below was reproduced, on the actual Fedora 43, 44, 45 and Rawhide
root filesystems (the official images, 2026-09-20), with each release's own
rpm, dnf, glibc and OpenSSL.

---

## 1. Fedora 45 moved to OpenSSL 4, and the engine needs OpenSSL 3

Fedora 45 (due 2026-10-20; the beta is out) ships OpenSSL 4.0, whose libraries are
`libssl.so.4` and `libcrypto.so.4`. The bundled llama.cpp is upstream's Ubuntu
build, and three of its files — `libllama-common.so`, `libllama-server-impl.so`,
`llama-cli` — need `libssl.so.3`:

```
Fedora 44:  version: 0.1.0-dev (build 10456, commit f275595dd)
Fedora 45:  llama-server: error while loading shared libraries: libssl.so.3:
            cannot open shared object file: No such file or directory
```

Fedora 45 does ship OpenSSL 3, as the compat package `openssl3-libs`
(`libssl.so.3()(64bit)`, `libcrypto.so.3()(64bit)`, symbol versions
OPENSSL_3.0.0 to 3.5.0). With those libraries present the engine starts on
Fedora 45 exactly as on 44. But dnf only installs a package for a requirement
that names it — and the spec said:

```
Requires:       openssl-libs >= 3.0
```

which `openssl-libs-4.0.2` satisfies. The package that spec produced, on
Fedora 45, with nothing providing OpenSSL 3 anywhere:

```
PASS  digests verify with Fedora's rpm
FAIL  dnf installed the package with no OpenSSL 3 available
```

What the user then gets is worse than "no engine". First-run setup completes —
the wizard only checks that the engine file is there, and the repo's own
onboarding test passes against this package on Fedora 45. The failure waits for
the first model:

```
 [..] starting llama-server from /usr/lib64/gobbonet/llama-cpp/llama-server
 [!]  llama-server did not start: cannot verify engine automatic memory fitting:
      exit status 127; use the pinned engine or choose an explicit GPU layer count
```

and every chat answers `model is not ready`. Exit status 127 is the dynamic
loader refusing the engine; nothing on screen says OpenSSL, and the hint points
at GPU layers. The 1.7.3-3 package that is out there now has the same
requirement line; on Fedora 45 its engine does not start either
(`test-in-fedora.sh --upgrade-from` prints it).

### The cause is the one INVESTIGATION-fedora-1.7.4.md called Finding 4

```
%global __requires_exclude_from ^%{_libdir}/gobbonet/llama-cpp(-cpu)?/.*$
```

threw away every requirement rpm derives from the engine, and 1.7.6 replaced
them with package names written by hand — `glibc >= 2.34`, `libstdc++ >= 12`,
`libgomp`, `libgcc`, `openssl-libs >= 3.0`. Package names cannot say "OpenSSL 3
and not 4". Sonames can.

### The fix

```
%global __requires_exclude ^(libvulkan|libggml|libllama|libmtmd)
```

rpm now writes the engine's requirements itself: 58 of them after the filter,
`libssl.so.3()(64bit)`, `libssl.so.3(OPENSSL_3.0.0)(64bit)`,
`libc.so.6(GLIBC_2.34)(64bit)`, `libstdc++.so.6(GLIBCXX_3.4.30)(64bit)`,
`libgomp.so.1(GOMP_4.5)(64bit)` and the rest. Two things stay filtered, for the
reasons they always were: Vulkan (optional; ggml falls through to its CPU
backends) and the engine's own libraries (private, found through `$ORIGIN`).

Checked against each release's real rpmdb: on Fedora 43 and 44 every one of the
58 is met by what is already installed. On Fedora 45 and Rawhide exactly four
are not — the OpenSSL 3 sonames — which is what makes dnf install
`openssl3-libs`. And with nothing providing them, dnf now refuses, naming the
library:

```
PASS  with no OpenSSL 3 provider, dnf refuses and names libssl.so.3
      - nothing provides libssl.so.3()(64bit) needed by gobbonet-1.7.6-1... from @commandline
```

That is the behaviour to want if a later Fedora drops `openssl3-libs` (it
carries `deprecated()`): a refusal at install time, not an engine that dies at
runtime.

## 2. Fedora 45 also enforces package signatures

`%_pkgverify_level` is `all` on Fedora 45 and Rawhide. `rpm -i` refuses an
unsigned package there (`does not verify: no signature`). `dnf install
./gobbonet-*.rpm` — the documented way in — does not: dnf skips OpenPGP checks
for a file named on its command line and says so
(`Warning: skipped OpenPGP checks for 1 package from repository: @commandline`).
Verified on 43, 44, 45 and Rawhide. The package stays unsigned; FEDORA.md now
says to use dnf, not `rpm -i`, and why.

`RPM_SIGN_KEY=<key id> ./build-rpm.sh` signs, for whenever that is wanted.
Tested with a throwaway key on Fedora 45: NOKEY before `rpm --import`, installed
after it.

## 3. The package depended on where it was built

Built anywhere but Fedora, the doc and licence directories came out versioned —
`/usr/share/doc/gobbonet-1.7.6/FEDORA.md` — because `_docdir_fmt` is
`%{NAME}` on Fedora and `%{NAME}-%{VERSION}` elsewhere. 1.7.3-3 shipped
`/usr/share/doc/gobbonet/`. And the build-id and payload settings lived on the
builder's command line, so `rpmbuild` run any other way got different ones.
All three are pinned in the spec now; the spec also refuses to parse without the
builder's defines, with a message saying so, instead of failing on an
unexpanded `%{gn_version}`.

## 4. build-rpm.sh had drifted from build-deb.sh

| | build-deb.sh | build-rpm.sh before | build-rpm.sh now |
|---|---|---|---|
| engine build | read from engine.sha256 | hardcoded `b10456` | read from engine.sha256 |
| hash check | every build | only on download, skipped if the pin file was absent | every build, pin required |
| cached archive | kept and re-verified | none; `SKIP_ENGINE_FETCH` trusted `vendor/` unchecked | kept and re-verified |
| engine guards | ELF stub, engine library, size, Vulkan backend | `llama-server` exists | same as deb |
| ENGINE.txt | yes | no | yes |
| stale CPU engine in vendor/ | not staged | staged | not staged |
| binary identity | — | — | `gobbonet version` must match VERSION |
| permissions | normalised + checked | inherited from the stage | normalised; checked in the package |

A pin bump would have made the old builder fetch the old archive and check it
against the new hash. The binary check refuses, for example, a 1.7.3 binary
handed to a 1.7.6 build (tested). The Release field now comes from the binary's
own version string, so the package names the build it carries.

Tested: a fresh download; a build under `umask 077` (identical to the normal one
in all 79 entries' modes, owners, digests and link targets); `SKIP_ENGINE_FETCH`
with nothing cached; a corrupted cached archive; a wrong-release binary; rpmbuild
run by hand. The last four refuse, each with the reason.

## 5. check-rpm.sh

Every Fedora package this project has shipped or nearly shipped installed
cleanly and was broken: 1.7.3-1's `/usr/bin/gobbonet` skipped setup, 1.7.4's
package had no wizard, and this one's engine could not start on Fedora 45. None
of that is visible to rpmbuild, and none of it needs Fedora hardware to catch.
`installer-fedora/check-rpm.sh` checks the finished package — its requirements,
provides, files, modes, link targets and contents — and `build-rpm.sh` removes a
package that fails it from `dist/`.

It fails the unmodified 1.7.6 spec's package on 14 counts and the shipped
1.7.3-3 on 15. Three deliberately broken builds — `/usr/bin/gobbonet` pointed at
the server, a 0700 program directory, Vulkan left in the requirements — each
fail on exactly the one check meant for them.

## 6. Smaller things

- **A root-run server's `web/`.** The server exports its page beside the binary
  whenever it can write there, which for a package means when someone ran
  `sudo gobbonet`. Reproduced: 46 files in `/usr/lib64/gobbonet/web`, owned by
  no package, and left behind by `dnf remove`. `%post` and `%preun` now remove
  that directory when it carries the server's `.gobbonet-ui` stamp.
- `/usr/bin/gobbonet` is a relative link.
- `grep` and `hicolor-icon-theme` are required: the launcher uses the first and
  the icon goes into the second's directories.
- License: `AGPL-3.0-or-later AND Apache-2.0 AND BSD-3-Clause AND MIT`, from
  `go version -m` and each module's LICENSE; llama.cpp's licence ships as
  `/usr/share/licenses/gobbonet/LICENSE.llama-cpp`.
- **make-zip.sh** pruned `dist stage vendor payload` but not `rpmbuild/`, so an
  archive made after an RPM build would have carried the payload tarball, the
  build tree and the package. And `find -name '*.deb' -o -name '*.rpm' -delete`
  only ever deleted the `.rpm` files — `-delete` bound to the second test alone.
  Both fixed.

## Result

`gobbonet-1.7.6-1.go.nogit.20260924.fedora.x86_64.rpm`, 20 MB, 101 MB
installed. `installer-fedora/test-in-fedora.sh` against it:

| | result |
|---|---|
| Fedora 43 | 20/20 |
| Fedora 44 | 20/20 |
| Fedora 45 | 21/21 |
| Rawhide (46) | 21/21 |

including, on each:

- the repo's own first-run test (`tests/test-linux-onboarding.py`) run as an
  ordinary user against the installed package, with Python 3.14 on 43 and 44
  and 3.15 on 45 and Rawhide, matching each release;
- GobboNet in **local mode**, as that user: its supervisor starting the bundled
  engine on a model and a chat request answered through its own proxy. The
  model is a sub-megabyte random-weight GGUF written by
  `installer-fedora/make-test-model.py` — it proves the engine loads a model
  and generates with Fedora's libraries, not that it is any good. This is the
  step the onboarding test never reaches, and the one that failed above;
- an upgrade from the shipped 1.7.3-3: its `web/` removed, every file under
  `/usr/lib64/gobbonet` owned by the new package, the engine path in existing
  configs still running, and the `web_root` the old launcher wrote ignored by
  the server, which serves its built-in page.

## Still outstanding

- **SELinux, a real desktop session, GNOME Software and GPU inference** are not
  testable in a chroot. They need Fedora hardware. GNOME Software's handling of
  an unsigned package on Fedora 45 in particular has not been seen.
- **`gobbonet uninstall` still suggests `sudo apt remove gobbonet`** on every
  Linux (`cmd/gobbonet/uninstall.go`). Fixing it means a new binary, so it waits
  for 1.7.7; FEDORA.md gives the dnf command meanwhile.
- **`openssl3-libs` is a compat package.** When Fedora retires it, the bundled
  engine needs a build that links OpenSSL 4 or none. dnf will say so first.
- INVESTIGATION-fedora-1.7.4.md's Finding 5 (a launcher failure with no dialog
  tool is silent) is a launcher change shared with Debian, and was not part of
  this.
