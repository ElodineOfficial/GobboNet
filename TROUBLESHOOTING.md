# Troubleshooting GobboNet

**Start with `gobbonet doctor`.** On Windows, open a Command Prompt in the
install folder (`%LOCALAPPDATA%\GobboNet` by default) and run
`gobbonet.exe doctor`. On Linux run `gobbonet doctor`; from the ZIP,
`./gobbonet doctor`. It prints:

- where the config, conversations and logs are;
- which engine it will start;
- whether the web port is free;
- the addresses a phone could use, and the firewall's say in it.

Most answers below start from something it shows.

Where an answer says to change something in `config.toml`, the chat page can
open it for you: **CONFIG > Advanced > Config File**, in a browser on the PC GobboNet runs
on. It checks a save before writing it and keeps the previous version, and the
change applies the next time GobboNet starts.

The server is `gobbonet.exe` (Linux: `gobbonet`). `launch.bat` asks its
questions, then hands over to it in the same window. Since 1.8 it is the only
server: the older PowerShell file server was removed, and `launch.bat` stops
with a message if `gobbonet.exe` is missing. If you updated by extracting a
ZIP, a `fileserver.ps1` from 1.7 may still be in the install folder. Nothing
runs it, and you can delete it; `gobbonet doctor` points it out.

Most problems land in one of four buckets. Work down in order — the first
one is far more common than people expect.

---

## A custom port did not take, or "I rebooted and it started working"

Both have the same short list of causes.

**Something was already holding the port.** Almost always a GobboNet left
over from a previous run. A reboot clears it, which is why rebooting appears
to fix a setting that was never wrong. `gobbonet.exe` stops and says so:

```
port 9066 is already in use, so nothing was started.
```

Run `stop-gobbonet.bat` from the install folder, then start again — no reboot
needed. It stops GobboNet's own processes and nothing else. Or end the holder
in Task Manager: `gobbonet doctor` shows whether the port is in use.

**The port file could not be read.** `.gobbonet-port` must contain a single
number. Earlier builds fell back to 9066 silently if it contained anything
else, so a port chosen during setup could vanish with no explanation. The
launcher now strips stray characters and, if nothing usable is left, prints
what the file actually contained.

**The chat works here but not on your phone, and the network is "Public".**
From 1.7.9, `setup-lan.bat` opens GobboNet on home and work networks only
(Windows calls them Private and Domain), not on Public ones such as cafes and
hotels. Windows often labels a home Wi-Fi network Public too. `setup-lan.bat`
notices, and asks whether to make the network Private; `gobbonet doctor`
says so in its **LAN ACCESS** section.

Fix, for a home network: Settings → Network & internet → your network →
**Private network**. Or re-run **setup-lan.bat** as Administrator and press
**P**. To allow Public networks as well (the pre-1.7.9 behaviour), run it as
`setup-lan.bat /public`. The chat is not encrypted, so only do that on a
network you trust.

**The chat works here but not on your phone.** The firewall rule and the
Windows URL reservation are both per-port, and neither carries over when the
port changes — so upgrading from a build that used 8080, or picking a custom
port, left them pointing at the wrong number.

Before 1.7.3 this was easy to hit and hard to see, because `setup-lan.bat`
resolved the port from `.gobbonet-port`, which is only written *after* the
server binds. Run from the installer's finish page it read a file that did not
exist yet and fell back to 9066 — correct on a fresh install by luck, wrong for
anyone upgrading from 8080. From 1.7.3 it asks the binary instead
(`gobbonet config get listen_port`), which is right before the server has ever
run.

Fix: right-click **setup-lan.bat** → Run as administrator. Then run
`gobbonet doctor` and read the **LAN ACCESS** section — it names the port the
rule is actually on.

To set a port for one run only:

```
set GOBBONET_LISTEN_PORT=9067
launch.bat
```

`GEMMA_LISTEN_PORT` is the old spelling. It still works and warns, but prefer
the current one — from 1.7.3 `setup-lan.bat` reads both, and before that it
read only the old one, so following the deprecation moved the server without
moving the firewall rule.

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

Your conversations are safe on the server's side, and GobboNet restores them
automatically the first time you open the new address. Since 1.7 that copy is
`state.json` in GobboNet's data folder (`gobbonet doctor`, under STORAGE).
Before 1.7 it was `.gobbonet-state.json` in the install folder, and 1.7 reads
it in once. If the sidebar is empty after a moment, force it from the Data
panel with **Restore from server**.

The old `:8080` origin still holds a copy too. Clearing it is optional;
see `docs/PURGE.md` if you want it gone.

### Why the port moved

8080 is the most contended port on a developer machine — Tomcat, Jenkins,
and most tutorial dev servers all reach for it, and Hyper-V, WSL2 and
Docker reserve blocks that swallow it. Squatting on it made GobboNet the
thing you had to close to get your own work started. 9066 ("gobb" on a
keypad) sits clear of all of that.

To pick a different port, set one during install, or edit
`.gobbonet-port` in the install folder — one line, just the number. For a
single run, `set GOBBONET_LISTEN_PORT=8420` before launching wins over both.

---

## The chat page will not load (nothing on :9066)

**Read the window first.** `gobbonet.exe` prints the reason it stopped in the
launcher window, and also appends it to `startup-error.log` beside the config.
`gobbonet doctor` shows that path under LOGS. A menu launch on Linux has no
window, so look in `~/.local/share/gobbonet/launch.log`.

| What it says | What it means |
|---|---|
| `port 9066 is already in use, so nothing was started` | Something holds the port, usually an earlier GobboNet — see the top of this page |
| `port 9066 was refused on every address` | Not a busy port: a reserved range or policy — see below |
| `LAN ACCESS IS OFF` with `Network bind failed: ...` | Working, but this PC only — the network address was refused, so it fell back to this PC |
| `access_secret ... is malformed`, or `no password is set` | Not a port problem at all — see *Password* below |

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
set GOBBONET_LISTEN_PORT=8420
launch.bat
```

…or reserve the port back and **reboot**:

```
netsh int ipv4 add excludedportrange protocol=tcp startport=9066 numberofports=1
```

`setup-lan.bat` now checks this for you and says so.

### Other bind causes

When the network address is refused but this PC's is not, the server keeps
going on `127.0.0.1` only. The chat works on this PC, and phones will not
reach it until that is fixed. On Windows, run `setup-lan.bat` as
Administrator: it adds the firewall rule for the port. `gobbonet doctor`
reports the rule under LAN ACCESS.

Another HTTP.SYS service (IIS, VMware, Citrix) can own the port first:

```
netsh http show servicestate                  :: another service owning the port?
```

GobboNet needs no URL reservation (`netsh http ... urlacl`). Versions up to
1.7.9 made one for the PowerShell server; since 1.8, `setup-lan.bat` and
`teardown-lan.bat` both remove it.

---

## Password problems

On Windows, `launch.bat` keeps the password in `.gobbonet-secret` in the
install folder, as one line of `<hex>:<hex>` with no trailing newline, and
hands it to `gobbonet.exe` on every launch. If that file is emptied,
truncated or locked by antivirus, the server can end up with no usable
password and stop before it listens, with `access_secret ... is malformed`.
In a hurry that reads like a port failure and sends people hunting the
wrong thing.

To start over, delete it and relaunch. `launch.bat` asks for a new password:

```
del "%LOCALAPPDATA%\GobboNet\.gobbonet-secret"
```

Use this rather than `gobbonet.exe set-password` on Windows: `launch.bat`
would hand the old password back on its next run.

If you see `.gobbonet-secret.bad`, a previous setup wrote something the
launcher could not parse. Its contents are kept for diagnosis; deleting it
is safe.

On Linux, run `gobbonet set-password`, then restart GobboNet.

### "My phone keeps asking me to sign in"

A sign-in lasts 12 hours (`session_ttl_hours` in the config), and only until
GobboNet restarts. It also belongs to one device and browser: it is tied to
the address the request came from and to the browser's identity. So a phone
signs in again when its network address changes (moving between Wi-Fi and
mobile data, or a new address from the router), when its browser updates,
or when you use a different browser on it. That is deliberate: a sign-in
copied off the network cannot simply be reused from another device.

A GobboNet icon on an iPhone or iPad home screen counts as its own browser:
iOS keeps its sign-in and storage apart from Safari's. Sign in once in it, and
your chats come over from the PC by themselves.

On the PC itself (`127.0.0.1`, `localhost`) a sign-in is tied to neither: no
one off the network can reach those addresses, so the tie protected nothing
there and only caused needless sign-ins.

### "It asked me to sign in again right after I signed in"

Since 1.7.8 the page double-checks before it asks: one refused request is not
enough, the next check has to be refused too. And a tab that is asking carries
on by itself once you sign in in another tab of the same browser.

If it still asks, the `gobbonet.exe` window says why, in a line starting
`[auth]`:

- **"a session this server did not issue"**: the sign-in is from before
  GobboNet restarted, or a second GobboNet on the same address but another
  port signed this browser in. Browsers share cookies across ports.
- **"reached its time limit"**: `session_ttl_hours` ran out.
- **"a different network address or browser"**: the device's address or
  browser changed (see above).

The browser console (F12) names the request that was refused, in a line
starting `[auth] signed out:`. Both lines are worth including in a bug report.

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
set GOBBONET_LISTEN_PORT=9066
launch.bat
```

---

## The model will not load

The reason is in `llama-server.log` in GobboNet's data folder
(`gobbonet doctor`, under LOGS). Two common causes:

- **Not enough VRAM.** Pick a smaller model or a heavier quantisation.
- **Stale server.** Closing the window without stopping the servers can
  leave `llama-server.exe` holding the port. Check with
  `netstat -ano | findstr "11437 11436 9066"` and end those PIDs.

If a model downloaded but never loads, check for a leftover `.part` file in
`models\` — that is an aborted download and is safe to delete.

**A model linked from "Found on this computer" stopped appearing.** USE IT
puts a *link* in your models folder, not a copy. If the original is deleted
(cleaning the HuggingFace cache, unplugging a drive), the link points at
nothing and GobboNet stops listing it. Link it again from Add a Model, or copy
the file into your models folder yourself. On Windows the link is a hard link,
so the data stays on disk until you delete it from **both** places.

**"could not link ... it is probably on a different drive".** Windows can only
make a hard link on the same drive. Turn on Developer Mode (Settings > System >
For developers), which lets GobboNet make a symbolic link instead, or move the
file to the drive your models folder is on.

**A model I have is not under "Found on this computer".** GobboNet looks in the
HuggingFace cache (`HF_HUB_CACHE`, `HF_HOME\hub`, or `.cache\huggingface\hub`
in your user folder) and in any folders listed as `model_dirs` in
`config.toml`, a few folders deep. Add the folder there, for example
`model_dirs = ["D:/models"]`. Projectors (`mmproj-...`), embedding models and a
split model with a part missing are left out on purpose: none of them can be
chatted with.

**"did not finish loading within 3m0s"** means the model was still loading when
GobboNet gave up. A big model on a slow disk, or one loading onto the CPU, can
need longer: raise `model_load_timeout_seconds` in `config.toml` (CONFIG >
Config File), for example to 600, and restart GobboNet. **"did not start
replying within 5m0s"** is the same for the prompt being read before a reply:
raise `reply_start_timeout_seconds`.

---

## "Matching by meaning is off"

The RAG Storybook and memory files can match by meaning through a small
embedding model. CONFIG > Privacy Status and the line under the storybook say
whether it is running, and why not. Names, tags and shared words keep matching
either way, so chat is never blocked by it.

Since 1.8.0 GobboNet starts the embedding server itself, restarts it if it
crashes, and rests it with the chat model; `gobbonet doctor` has an EMBEDDING
SERVER section. The reasons it shows:

- **No embedding model.** It is optional, about 140 MB. On Windows, run
  *Setup or add a model* (or `launch.bat`) once and it is downloaded; on Linux,
  run `gobbonet setup` and choose *Download Nomic*. Then restart GobboNet.
- **It does not match its pinned SHA-256.** The file is damaged or not the one
  GobboNet expects, so it is not started. Delete it (the path is in the
  message) and download it again as above.
- **Restarting.** It stopped and GobboNet is bringing it back, waiting a little
  longer after each try. `embed-server.log`, beside `llama-server.log`, says
  why it stopped.
- **Something else is on its port** (11436). An embedding server GobboNet did
  not start is used as it is, and GobboNet starts its own when that one goes.
  Anything else holding the port: see the netstat line above.
- **Off.** `embed_mode = "off"` in `config.toml` (CONFIG > Advanced > Config
  File). `"managed"` is the default; `"external"` uses a server of your own at
  `embed_url`. On Windows, `EMBED_ENABLE=0` in `launch.bat` writes `"off"`.

---

## An MCP server says "Not working"

An MCP server is a program on this PC that gives characters tools (1.8.0).
CONFIG > Advanced > MCP Servers lists each one with its state, and the reason
when it is not working; `gobbonet doctor` has an MCP SERVERS section, and each
server's own error output is in `mcp-<name>.log` beside `llama-server.log`.

- **"... was not found on this PC's PATH".** The program is not installed, or
  GobboNet cannot see it. `npx` and `uvx` come with Node.js and uv. Install it,
  or give the program's full path as the command. GobboNet started from the
  Start menu or a desktop file may have a shorter PATH than your terminal.
- **"Could not start it: it exited (exit status 1): ..."** The program started
  and stopped. The end of the line is the last thing it printed; the log has
  the rest. A wrong argument, such as a folder that does not exist, is the
  usual cause.
- **"no answer within 2m0s".** The program is running but is not speaking MCP
  over stdin and stdout. Check its instructions for a `--stdio` option. A
  server that is only reachable at a web address (a `url`) is not supported in
  1.8.0.
- **"tries again in ... s".** It failed and GobboNet waits a little longer
  after each try. The next use after that starts it again, or SWITCH OFF and
  SWITCH ON there and then.
- **No ADD SERVER or SWITCH ON.** Those work only in a browser on the PC
  GobboNet runs on, at `http://localhost`, because they decide which programs
  run there. Any device can switch one off.

---

## CHECK FOR UPDATES says something other than "UPDATE NOW"

ABOUT > CHECK FOR UPDATES (1.8.0) asks GitHub when you press it. What it can
say instead of offering UPDATE NOW, and what to do:

- **"Updates are installed from GobboNet on the PC it runs on."** You are on a
  phone or another device. Open ABOUT on the PC, at `http://localhost`.
- **"This copy was installed from a .deb or .rpm package."** Install the new
  package from the release page over the old one. Your chats, models and
  settings are kept.
- **"GobboNet cannot write to its own folder."** It is in a folder your user
  cannot change. Replace `gobbonet.exe` by hand (README.md, *Updating to a
  newer version*), or move the GobboNet folder somewhere you own.
- **"...built without the update signing key."** That build cannot check where
  a download came from, so it installs nothing. Update by hand once; the
  release builds after that can update themselves.
- **"GitHub is limiting how often this network can ask."** GitHub allows about
  60 checks an hour from one address, shared by everything on your network.
  Try again later.
- **"The update was not installed, and nothing was changed: ..."** A check
  failed: the download did not match what the release promised, or the new
  program would not start. Your copy is as it was. CHECK AGAIN tries a fresh
  download. If it fails the same way twice, download the release by hand and
  report it.
- **It restarted but the page did not come back.** Start GobboNet again as you
  usually do; the new version is the one that runs. If anything is wrong with
  it, the one it replaced is beside it as `gobbonet.exe.old` until GobboNet has
  started once. Rename it back to `gobbonet.exe` to undo the update.

---

## Mods

**"Mods are managed from GobboNet on the PC it runs on."** Adding, changing,
switching on, reordering or removing a mod works only in a browser on the PC
GobboNet runs on, opened at `http://localhost:9066`. This is on purpose: a mod
is code that runs in every browser that opens GobboNet, so a phone or another
device must never be able to put code there. From any signed-in device you can
still switch a mod **off**.

**A mod I added by hand does not show, or says "Cannot load".** It has to be a
folder directly inside the `mods` folder (MODS shows where), named in
lower-case letters, digits, `.`, `-` or `_`, with a `mod.json` that lists its
files:

```json
{ "name": "Neon theme", "version": "1.0", "files": ["theme.css", "extra.js"] }
```

Every file it lists must be inside the folder, and must not be a link. The
reason it cannot load is shown under its name. A mod added by hand starts
switched off.

**I switched a mod off but it is still doing something.** A stylesheet goes
away at once. A script that has already run keeps running until the page
reloads.

**One stylesheet or script in My extensions is the problem.** Each entry has
its own **Enabled** switch, beside its name, so you can turn just that one off
and keep the rest. Like the mod switches, it takes effect at once, and a phone
can switch an entry off but only the PC can switch one on. A new entry's switch
is kept when you press SAVE.

**My extensions from before 1.7.9.** They became the mod "My extensions" the
first time you opened 1.7.9 on the PC, switched on or off as they were. A phone
that held them keeps running them until GobboNet has been opened on the PC
once.

**"... was switched off: it stopped with an error while loading."** One of the
mod's own files could not be loaded, or its script failed as it started, so
GobboNet switched the mod off to keep the page working. Anything it already did
stays until you reload. SWITCH BACK ON tries again; if it keeps happening, the
mod needs fixing (or an update), and its author wants the message from the
notice. Errors a mod makes later, after it has started, do not switch it off.

**A mod breaks the page so badly I cannot reach MODS.** Open GobboNet with
`?nomods` on the end of the address (`http://localhost:9066/?nomods`). That
page loads no mods at all; switch the culprit off in MODS, then reload without
`?nomods`.

**ENDORSED MODS says the list could not be reached.** GobboNet fetches the list
from goblincorps.com when you click BROWSE. If it has fetched it before, it
shows that copy and says from when. Mods you already installed keep working
either way. `mod_list_url` in config.toml is where it looks; empty switches the
list off.

**"... does not match the checksum the endorsed list pins for it, so nothing
was installed."** The file on the site is not the one Elodine endorsed: it
changed after the list was made, or something between you and the site changed
it. Nothing was installed, and a mod you already had is untouched. Try again
later; if it persists, tell Elodine which mod.

**INSTALL is greyed out, or "already in your mods folder".** Install works only
on the PC GobboNet runs on. A mod whose name matches a folder you made yourself
is never installed over it: rename or remove your folder first.

---

## The Gobbonet Informant says something that is not right

The Informant is a character with notes about this version of GobboNet; a small
model can still mix them up. It is told to say "I don't know" rather than
guess, so an answer that names a button you cannot find is worth checking here.

If you added the Informant before 1.7.9, your copy still has the older notes.
On the home screen its tile says **UPDATE**: click it to bring it up to date.
Your colours, banned phrases and other extras on that card are kept, and UNDO
puts the old version back for 10 seconds. A tile that says **ADDED** is already
current. The same goes for the other default characters.

---

## Windows Defender, and how to stop it interfering

GobboNet has a shape Defender does not like: it downloads a multi-gigabyte
file, opens several local listening ports, and runs scripts and programs out
of a folder in your user profile. Every one of those is normal here and every one
of them is also what a lot of malware does. Defender judges the shape, not
the intent, so it sometimes acts.

The most disruptive version of this is not a warning at all — it is a
scheduled scan quarantining a file overnight while you are away from the PC.
You come back to a model that will not load, or a launcher that stops
partway, with nothing on screen explaining why.

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

**The cost:** Defender does not scan anything in an excluded folder. Keep
only GobboNet there, and don't save other downloads into it.

### Other symptoms worth knowing

- **SmartScreen: "Windows protected your PC"** on the installer. It is
  unsigned — **More info → Run anyway**. Verify the SHA-256 against the
  release page if you want certainty about the bytes. Firefox may also hold
  the download back as not commonly downloaded; allow it from the downloads
  list.
- **`gobbonet.exe` or a script is missing from the install folder.**
  Antivirus quarantine, or an AppLocker/WDAC policy blocking it. Check your
  antivirus protection history first — a quarantined file is listed there
  with a timestamp. `launch.bat` says so by name when it is `gobbonet.exe`
  that is gone.
- **A model that loaded yesterday will not load today.** Check the models
  folder still contains the `.gguf`. A quarantined file disappears silently.

None of this requires turning Defender off, and you should not. A folder
exclusion is narrower and reversible.

---

## Linux

Linux is supported natively: a `.deb`, an `.rpm`, an AppImage, or the ZIP.
See `LINUX-START-HERE.md`. A launch from the application menu has no
window, so its messages and the setup page's address go to
`~/.local/share/gobbonet/launch.log`.

Running the Windows launcher under Wine is not supported, and with a native
build there is no reason to. `launch.bat` detects Wine and says so.

---

## The graphics card works hard on every message in a long chat

Before each reply the model reads the prompt. llama.cpp keeps the last one and
only reads again from the first point that changed. A character with a RAG
Storybook or memory files gets lorebook snippets that change from message to
message, and by default they sit near the top of the prompt, so the whole
conversation is read again each time. On a big model and a long chat that can
mean a burst of full GPU load, and power draw, before every reply.

In CONFIG, under **Prompt Order**, tick **Put lorebook snippets just before my
newest message** and save. Only the end of the prompt is read again from then
on. It changes nothing for a character without a lorebook.

---

## A name nobody used keeps turning up in the chat

Before 1.7.8, the instructions Lore System used to summarise old messages
included an example with the names **Lucia** and **Vasch**. Small models
sometimes copied them into a thread's lore, and the character then treated
them as part of the story. The instructions no longer name anyone, but lore
written before the update keeps what it has. To clear it:

1. Open the thread and click the lore chip in the chat header.
2. Choose **EDIT**, delete the lines with the stray names, and save.

A character can also be given its own summary instructions: tick **Edit the
lore summary prompt** in the character editor, next to RAG Storybook.

---

## A group chat waits before every reply, or a member speaks for the others

**The wait.** In a group chat (1.8.0) one model plays every member, one reply
at a time, and each member's turn begins with that member's own card. So the
prompt changes from its first lines at every change of speaker, and the model
reads the whole conversation again before each reply, where a chat with one
character only reads what is new. With **DM decides**, the DM's question is
one more short request before each reply. On a long chat with a big model
that is a pause before every member, and nothing in the chat is wrong.

What shortens it: fewer **Replies per round** in the group's editor, so a
round is two members instead of five; **Turn order**, **Natural** or
**Manual** in place of the DM; and a lower **Context limit** on the members'
cards, which caps how much of the chat each one reads.

**A member writes somebody else's lines.** The group's **End a reply where it
starts writing another member's lines** box (on by default) ends a reply at a
line that begins with another member's name, and takes a member's own name
off the front. It cannot catch a member narrating what the others do inside
its own prose. A line in the group's **Scene** helps most models: *Each
character speaks and acts only for themselves.* **Cap this character's reply
length** on the talkative character's card helps too.

**"The DM gave no clear answer, so the turn order decided."** The DM is the
loaded model, asked to answer with one name. A small model sometimes answers
with a sentence that names nobody on the list, or with nothing; the round
then carries on in turn order and the bar says so. Keep **How the DM should
choose** to a line or two, or use Natural order, which needs no extra request.

---

## Still stuck

Open an issue with the bug report form. These usually let it be answered in
one reply:

1. The output of `gobbonet doctor` (read it over first: it shows local
   addresses and folder paths)
2. **COPY BUILD INFO** from ABOUT in the app, if the chat page opens
3. What the launcher window printed last, or on Linux,
   `~/.local/share/gobbonet/launch.log`
4. `llama-server.log` if a model will not load (`gobbonet doctor` shows where
   it is)
5. On Windows, if the port is refused:
   `netsh interface ipv4 show excludedportrange protocol=tcp`

Security problems go privately to Elodine on the GobboNet Discord, not in an
issue.
