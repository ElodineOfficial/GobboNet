# Troubleshooting GobboNet

Most problems land in one of four buckets. Work down in order — the first
one is far more common than people expect.

---

## "My chats vanished after updating"

They did not. 1.5.5 moved the default port from **8080 to 9066**, and a
browser keys its storage to the exact address you opened — so
`localhost:9066` is a different origin from `localhost:8080` and starts
empty.

Your conversations are safe in `.gobbonet-state.json` in the install
folder, and GobboNet restores them automatically the first time you open
the new address. If the sidebar is empty after a moment, force it from the
Data panel with **Restore from server**.

The old `:8080` origin still holds a copy too. Clearing it is optional;
see `PURGE.md` if you want it gone.

### Why the port moved

8080 is the most contended port on a developer machine — Tomcat, Jenkins,
and most tutorial dev servers all reach for it, and Hyper-V, WSL2 and
Docker reserve blocks that swallow it. Squatting on it made GobboNet the
thing you had to close to get your own work started. 9066 ("gobb" on a
keypad) sits clear of all of that.

To pick a different port, set one during install, or edit
`.gobbonet-port` in the install folder — one line, just the number. For a
single run, `set GEMMA_LISTEN_PORT=8420` before launching wins over both.

---

## The chat page will not load (nothing on :9066)

**Read the log first.** `fileserver.ps1` prints the exact reason it failed,
and as of 1.5.4 it writes that to `fileserver.log` in the install folder.
launch.bat prints the file for you when the server does not come up.

```
type "%LOCALAPPDATA%\GobboNet\fileserver.log"
```

That one file separates four failures that look identical from outside:

| What the log says | What it means |
|---|---|
| `[FATAL] No access secret provided` | Not a port problem at all — see *Password* below |
| `[fatal] cannot create System.Net.HttpListener` | PowerShell is in a restricted language mode (WDAC/AppLocker) |
| `[warn] could not bind ... [ok] listening on 127.0.0.1` | Working, but this PC only — run `setup-lan.bat` for phone access |
| `[fatal] could not bind ... either` | Port genuinely unavailable — checklist below |
| *(no log file at all)* | PowerShell never ran the script: AppLocker policy or antivirus quarantine |

### "netstat says nothing is using the port"

That can be true and the port still unbindable. **netstat cannot see
Windows port reservations.** Hyper-V, WSL2, Docker Desktop and the Windows
NAT service reserve large dynamic TCP blocks, and a web port can land inside one
often enough to be a leading suspect. Check with:

```
netsh interface ipv4 show excludedportrange protocol=tcp
```

If a range covers your port, either use a different port:

```
set GEMMA_LISTEN_PORT=8420
launch.bat
```

…or reserve the port back and **reboot**:

```
netsh int ipv4 add excludedportrange protocol=tcp startport=9066 numberofports=1
```

`setup-lan.bat` now checks this for you and says so.

### Other bind causes

```
netsh http show urlacl url=http://+:9066/     :: missing reservation? run setup-lan.bat as admin
netsh http show servicestate                  :: another service (IIS, VMware, Citrix) owning it?
```

Note that a missing URL ACL is no longer fatal — the server falls back to
`127.0.0.1` only. The chat works on this PC; phones will not reach it until
you run `setup-lan.bat` as Administrator.

---

## Password problems

The password lives in `.gobbonet-secret` as one line of `<hex>:<hex>` with
no trailing newline. If it is emptied, truncated or locked by antivirus,
the file server exits before it ever tries to listen — which looks exactly
like a port failure and sends people hunting the wrong thing.

To start over, delete it and relaunch:

```
del "%LOCALAPPDATA%\GobboNet\.gobbonet-secret"
```

If you see `.gobbonet-secret.bad`, a previous setup wrote something the
launcher could not parse. Its contents are kept for diagnosis; deleting it
is safe.

---

## The console says "Waiting for server to come back up..." forever

If the chat works in the browser but the launcher window keeps printing
dots, the monitor and the server disagree about what "up" means.

`/health` answers `ok` only when llama-server is idle and loaded. While it
is loading a model, or busy with the reply you are reading, it answers
something else. The monitor used to treat that as death: it killed a
perfectly good server, restarted it, then asked the same question and got
the same answer, forever.

Fixed in 1.5.8. The monitor now separates three states — healthy, running
but not ready, and not running at all — and only the last one justifies a
restart. A server that is running and serving is left alone.

The same change stopped the monitor killing the **embedding server**. Both
it and the chat model are `llama-server.exe`, and the old
`taskkill /f /im llama-server.exe` took out both, silently disabling RAG
until you restarted the launcher. The kill now targets the chat model's
port specifically.

---

## "llama-server already running" but nothing works

If you have **Ollama** installed, older versions of GobboNet mistook it for
llama.cpp. Both used port 11434, and the launcher accepted any HTTP answer
as proof its own server was up -- including Ollama's 404. It then skipped
starting llama.cpp, found nothing healthy, and restarted into a port Ollama
already owned.

Fixed in 1.5.8 two ways: llama.cpp now defaults to **11437**, and the
launcher requires a 200 with the expected body before believing a service
is its own.

If you still see a collision, set the ports explicitly before launching:

```
set GEMMA_LLM_PORT=11437
set GEMMA_LISTEN_PORT=9066
launch.bat
```

---

## The model will not load

The launcher stops and shows `llama-server.log`. Two common causes:

- **Not enough VRAM.** Pick a smaller model or a heavier quantisation.
- **Stale server.** Closing the window without stopping the servers can
  leave `llama-server.exe` holding the port. Check with
  `netstat -ano | findstr "11437 11435 11436 9066"` and end those PIDs.

If a model downloaded but never loads, check for a leftover `.part` file in
`models\` — that is an aborted download and is safe to delete.

---

## Windows or antivirus blocking things

The installer is unsigned, so SmartScreen shows "Windows protected your PC"
— **More info → Run anyway**. Separately, some antivirus engines quarantine
unsigned NSIS installers or the `.ps1` files outright rather than warning.

If `fileserver.log` is never created, that is the signature: PowerShell
never ran the script. Check your antivirus protection history, and add the
install folder to its exclusions.

---

## Linux / Wine

Not supported yet. `fileserver.ps1` **is** the web server, and with the
hardware probe and model identifier that is roughly 4,000 lines of
PowerShell, which Wine does not implement. The launcher detects Wine, says
so, and continues anyway — people have got it running by patching around
the gaps, and nothing here will stop you trying.

---

## Still stuck

Include these in a bug report and it can usually be answered in one reply:

1. `fileserver.log` (whole file)
2. Whether launch.bat printed **"No working PowerShell found"**
3. Whether it printed **`[OK] Search proxy on :11435`** — that line proves a
   PowerShell HTTP listener bound successfully minutes earlier, which rules
   out a whole class of theories
4. Output of `netsh interface ipv4 show excludedportrange protocol=tcp`
