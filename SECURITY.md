# Security model

GobboNet runs on your machine and talks to a model on your machine. This
describes what is protected, what is not, and where the boundaries actually
sit — not the marketing version.

---

## The password

Set on first run, stored in `.gobbonet-secret` as `<salt>:<hash>` where the
hash is SHA-256 of salt+password, UTF-8, lowercase hex. **The password
itself is never written anywhere.**

It exists for one reason: if you open GobboNet to your home network, that
password is the only thing standing between your chats and everyone else on
that network — a housemate, a guest, a compromised smart TV. Choose
accordingly. Six characters is the enforced minimum, not a recommendation.

Without LAN setup, the server binds `127.0.0.1` only and nothing off the
machine can reach it regardless.

---

## What is exposed, and to whom

| Port | Bound to | Purpose |
|---|---|---|
| 9066 | `+` (all interfaces) after `setup-lan.bat`, else `127.0.0.1` | the chat UI |
| 11437 | `127.0.0.1` | llama-server |
| 11435 | `127.0.0.1` | search proxy |
| 11436 | `127.0.0.1` | embedding server |

llama-server moved off 11434 because that is Ollama's default port and the
two collided on any machine with Ollama installed. All four ports are
overridable: `GEMMA_LISTEN_PORT`, `GEMMA_LLM_PORT`, `GEMMA_SEARCH_PORT`,
`GEMMA_EMBED_PORT`.

`setup-lan.bat` scopes its firewall rules to `remoteip=LocalSubnet`, so the
wider internet cannot reach any of it. Only the machines on your own network
can, and only with the password.

**Do not port-forward the web UI port.** Nothing here is built to face the internet:
there is no rate limiting, no TLS, and no account system.

---

## What leaves your machine

Two downloads, both on first run, both to fetch software rather than send
anything:

- **github.com** — the pinned llama.cpp build
- **huggingface.co** — the model you chose

After that, nothing. No telemetry, no crash reports, no usage statistics.
The only remaining outbound calls are ones you trigger: the optional web
search, and reaching the chat from another device on your own network.

You can verify this rather than trusting it — the whole install folder is
plain scripts and one web page.

---

## Where your conversations live

Two places, and both matter if you are handling anything sensitive:

1. **The browser**, in localStorage/IndexedDB keyed to the address you
   opened. Every address is separate — `127.0.0.1:9066`, `localhost:9066`,
   your `.local` name, any LAN IP — and a phone that connected keeps its own
   copy.
2. **`.gobbonet-state.json`** in the install folder, mirrored by the file
   server so a reload never loses a thread.

Uninstalling removes the state file and the job spool. **It cannot reach
into a browser profile** — clear that yourself from site settings, for each
address you used. See `PURGE.md` for the full procedure.

---

## What this does not protect against

Stated plainly, because implied guarantees are worse than none:

- **Anyone with access to your user account.** The state file and the
  browser storage are both readable by you, and therefore by anything
  running as you.
- **Malicious character cards.** A card can carry custom JavaScript. It
  arrives **disabled** and stays disabled until you open the editor and
  switch it on — but if you switch it on, it runs with full page access.
  Read it first.
- **The model itself.** A local model can still be wrong, and a card can
  still be written to manipulate. Nothing here filters output.
- **Anyone on your LAN with the password.** That is the whole design.

---

## The installer is unsigned

SmartScreen will warn. Verify the download against the SHA-256 published on
the release page rather than trusting the file:

```powershell
Get-FileHash GobboNetSetup.exe -Algorithm SHA256
```

Signing costs money that this project does not take, so verification is the
substitute. It is a better one than a certificate anyway — a hash proves the
bytes, a certificate proves someone paid a fee.
