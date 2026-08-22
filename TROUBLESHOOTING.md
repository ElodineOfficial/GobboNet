# Troubleshooting GobboNet

Most problems land in one of four buckets. Work down in order — the first
one is far more common than people expect.

---

## A custom port did not take, or "I rebooted and it started working"

Both have the same short list of causes.

**Something was already holding the port.** Almost always a GobboNet file
server left over from a previous run — closing the launcher window does not
stop it. A reboot clears it, which is why rebooting appears to fix a setting
that was never wrong. From 1.5.9 the launcher checks first and names the
holder:

```
[*] Port 9066 is already in use by PID 9312 (powershell.exe).
```

End that PID in Task Manager and start again — no reboot needed.

**The port file could not be read.** `.gobbonet-port` must contain a single
number. Earlier builds fell back to 9066 silently if it contained anything
else, so a port chosen during setup could vanish with no explanation. The
launcher now strips stray characters and, if nothing usable is left, prints
what the file actually contained.

**The chat works here but not on your phone.** Windows needs a URL
reservation per port, and it does not carry over when the port changes — so
upgrading from a build that used 8080, or picking a custom port, leaves the
old reservation pointing at the wrong number. The server falls back to this
PC only and the launcher now says so. Fix: right-click **setup-lan.bat** →
Run as administrator. It reads the same port the launcher is using and
cleans up the stale reservation.

To set a port for one run only:

```
set GEMMA_LISTEN_PORT=9067
launch.bat
```

That beats `.gobbonet-port`, which beats the 9066 default.

---

## "My character's picture disappeared after updating"

It shows a letter now instead of the avatar. Nothing was deleted.

Some cards store the picture **inside** the card; others just hold a web
address pointing at one. From 1.5.9, GobboNet no longer loads the second
kind by default — fetching a picture from a website tells that website your
IP address, and it happens the moment a message renders, without you
clicking anything. In an app whose whole point is that nothing leaves your
machine, that was the one thing that did.

Pictures pasted or uploaded directly into a card are unaffected and always
work.

**To load them again:** Settings → **Remote Images In Cards** → tick *Allow
remote images*. Avatars and backgrounds repaint immediately; no reload.

The address is still on the card either way, so you can flip this back and
forth freely. If you would rather make the picture permanent, download it
and re-upload it into the card — then it lives in the card and the setting
stops mattering.

You should have seen a one-time notice about this on first launch. It only
appears if you actually have an affected card, and only once.

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
  `netstat -ano | findstr "11437 11436 9066"` and end those PIDs.

If a model downloaded but never loads, check for a leftover `.part` file in
`models\` — that is an aborted download and is safe to delete.

---

## Windows Defender, and how to stop it interfering

GobboNet has a shape Defender does not like: it downloads a multi-gigabyte
file, opens several local listening ports, and runs PowerShell out of a
folder in your user profile. Every one of those is normal here and every one
of them is also what a lot of malware does. Defender judges the shape, not
the intent, so it sometimes acts.

The most disruptive version of this is not a warning at all — it is a
scheduled scan quarantining a file overnight while you are away from the PC.
You come back to a model that will not load, or `fileserver.log` that was
never written, with nothing on screen explaining why.

**Excluding the folder prevents that:**

```
Windows Security  >  Virus & threat protection  >  Manage settings  >
Exclusions  >  Add an exclusion  >  Folder  >  pick your GobboNet folder
```

The default folder is:

```
%LOCALAPPDATA%\GobboNet
```

The installer shows this on its own screen before first launch, so if you
skipped past it, this is that.

### Other symptoms worth knowing

- **SmartScreen: "Windows protected your PC"** on the installer. It is
  unsigned — **More info → Run anyway**. Verify the SHA-256 against the
  release page if you want certainty about the bytes.
- **`fileserver.log` is never created.** PowerShell never ran the script at
  all. Antivirus quarantine or an AppLocker/WDAC script policy. Check your
  antivirus protection history first — a quarantined file is listed there
  with a timestamp.
- **A model that loaded yesterday will not load today.** Check the models
  folder still contains the `.gguf`. A quarantined file disappears silently.

None of this requires turning Defender off, and you should not. A folder
exclusion is narrower and reversible.

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
3. Whether the chat page itself loaded — that proves a PowerShell HTTP
   listener bound successfully, which rules out a whole class of theories
4. Output of `netsh interface ipv4 show excludedportrange protocol=tcp`
