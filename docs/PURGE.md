# Removing your GobboNet data

Conversations live in more than one place, and only some of them can be
reached by the app. This is the complete list, what clears each, and what
nothing can clear.

---

## Where the data actually is

| Location | What is there | Cleared by |
|---|---|---|
| Browser storage on this PC | every thread, character, persona, macro, plus cached embeddings and retrieval telemetry | **Data → PURGE ALL** in the app |
| `.gobbonet-state.json` in the install folder | a mirror of the above, so a reload never loses a thread | uninstalling |
| `.jobs\` in the install folder | in-flight generation spool | uninstalling |
| Browser storage on a **phone or tablet** that connected | a full copy, held by that device | only that device |

The important one: **browser storage is keyed to the exact address you
opened**, so `127.0.0.1:9066`, `localhost:9066`, `pcname.local:9066` and a
LAN IP are four separate buckets. Clearing one does not touch the others.

---

## Clearing this PC

### 1. In the app — the fast path

**Data → PURGE ALL.** This deletes threads, characters, personas,
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

Uninstalling removes `.gobbonet-state.json` and the job spool. If you are
not uninstalling and want it gone now, stop GobboNet and delete it:

```powershell
Remove-Item "$env:LOCALAPPDATA\GobboNet\.gobbonet-state.json" -Force
Remove-Item "$env:LOCALAPPDATA\GobboNet\.jobs" -Recurse -Force
```

Adjust the path if you installed elsewhere. To find every copy on the
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
Get-ChildItem "$env:LOCALAPPDATA\GobboNet" -Force |
  Where-Object { $_.Name -like ".gobbonet*" -or $_.Name -like "*.log" }
```

An empty result means the install folder holds no conversation data.
