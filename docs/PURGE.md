# Removing your GobboNet data

Conversations live in more than one place, and only some of them can be
reached by the app. This is the complete list, what clears each, and what
nothing can clear.

---

## Where the data actually is

| Location | What is there | Cleared by |
|---|---|---|
| Browser storage on this PC | every thread, character, group, persona, macro, plus cached embeddings and retrieval telemetry | **Data → PURGE ALL** in the app |
| `state.json` in GobboNet's data folder, plus `state-<name>.json` device-sync backups | the server's mirror of the above, so a reload never loses a thread; encrypted if you turned encryption on | `gobbonet uninstall` (the Windows uninstaller runs it) |
| `.gobbonet-state.json` and `.jobs\` in the install folder | the same mirror and generation spool from before 1.7; 1.7 reads the mirror in once and leaves the file | the Windows uninstaller |
| Browser storage on a **phone or tablet** that connected | a full copy, held by that device | only that device |

`gobbonet doctor` shows the data folder under STORAGE. It is normally:

- **Windows:** `%USERPROFILE%\.local\share\gobbonet`
- **Linux:** `~/.local/share/gobbonet`

The important one: **browser storage is keyed to the exact address you
opened**, so `127.0.0.1:9066`, `localhost:9066`, `pcname.local:9066` and a
LAN IP are four separate buckets. Clearing one does not touch the others.

---

## Clearing this PC

### 1. In the app — the fast path

**Data → PURGE ALL.** This deletes threads, characters, groups, personas,
schedules, folders, macros, extensions, cached embeddings and retrieval
telemetry from this browser, then resets to a clean install.

It reports anything it could not clear. If you see a list, close any other
GobboNet tabs and run it again — a second tab holding the database open
blocks deletion.

> Before 1.5.9 this button did **not** actually delete stored
> conversations. It reset what was on screen and left every record in
> place, so history could reappear on reload. If you purged on an earlier
> version, purge again on 1.5.9 or clear site data as below.

PURGE ALL clears **this browser only**. It does not touch the server-side
mirror or any other device.

### 2. The server-side mirror

`gobbonet uninstall` removes it, along with the config and stored password
and the files GobboNet keeps beside them (its logs, what the update button
downloads, and on Linux the embedding model setup fetched), and asks before
touching your models. The Windows uninstaller runs it for you, and asks
about the models itself. Run it yourself to clear everything without
uninstalling the program: stop GobboNet first, then from the install folder
on Windows,

```
gobbonet.exe uninstall
```

or `gobbonet uninstall` on Linux. The next launch starts setup again.

To remove only the conversations and keep your settings, stop GobboNet and
delete the mirror from the data folder:

```powershell
$data = "$env:USERPROFILE\.local\share\gobbonet"
Remove-Item "$data\state.json", "$data\state.json.bak", "$data\state-*.json*" -Force
```

```sh
rm -f ~/.local/share/gobbonet/state.json ~/.local/share/gobbonet/state.json.bak \
      ~/.local/share/gobbonet/state-*.json*
```

Use the folder `gobbonet doctor` shows if yours differs. If you turned on
encryption, `state.keyring` beside them holds the key; it can go too.

**Installs from before 1.7** kept the mirror in the install folder. 1.7
reads it in once and leaves it there. To delete it:

```powershell
Remove-Item "$env:LOCALAPPDATA\GobboNet\.gobbonet-state.json" -Force
Remove-Item "$env:LOCALAPPDATA\GobboNet\.jobs" -Recurse -Force
```

Adjust the path if you installed elsewhere. To find every old copy on the
machine, including old test installs:

```powershell
Get-ChildItem $env:USERPROFILE -Recurse -Force -Filter ".gobbonet-state.json" `
  -ErrorAction SilentlyContinue | Select-Object FullName, Length, LastWriteTime
```

### 3. Browser storage, the thorough way

An uninstaller is a native program; the data sits inside a browser profile
and no installer can reach in. Clear it yourself:

- **Chrome / Edge** — open the chat, press F12 → Application → Storage →
  **Clear site data**. Or Settings → Privacy → third-party cookies → See all
  site data → search the port number → delete.
- **Firefox** — Settings → Privacy → Cookies and Site Data → Manage Data →
  search the address → Remove.

**Do this for every address you used.** Each is a separate bucket:
`127.0.0.1:9066`, `localhost:9066`, your PC's `.local` name, and any LAN IP.
If you changed the port at some point, the old port is a separate bucket
again.

---

## Clearing a phone or tablet

Whatever a device downloaded, it kept. Nothing on the PC can reach it —
there is no push channel, and at uninstall time the server is being torn
down anyway.

On the device itself, open the same address and clear site data through the
mobile browser's settings. On iOS Safari: Settings → Safari → Advanced →
Website Data → find the address → swipe to delete.

If you cannot get the device back, that copy stays where it is. That is a
real limit, not an oversight — see below.

---

## What cannot be cleared

**A device that connected once and never came back.** A phone that used the
chat over your LAN holds a full copy in its own browser storage. There is no
mechanism on the PC side that reaches it. Uninstalling GobboNet does not
change that, and no future version can, because the only channel that ever
existed was the phone asking the server for something.

If you are handling material where that matters, the practical answer is to
clear each device while you still have it, before uninstalling.

---

## Verifying

After purging and clearing site data, reload the chat. An empty sidebar and
a default character mean this browser is clean. To be sure nothing is left
on disk:

```powershell
Get-ChildItem "$env:USERPROFILE\.local\share\gobbonet" -Force -Filter "state*"
Get-ChildItem "$env:LOCALAPPDATA\GobboNet" -Force -Filter ".gobbonet-state*"
```

```sh
ls -a ~/.local/share/gobbonet | grep '^state'
```

No results means neither the data folder nor the install folder holds
conversation data.
