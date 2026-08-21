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
| 11436 | `127.0.0.1` | embedding server |

llama-server moved off 11434 because that is Ollama's default port and the
two collided on any machine with Ollama installed. The remaining ports are
overridable: `GEMMA_LISTEN_PORT`, `GEMMA_LLM_PORT`, `GEMMA_EMBED_PORT`.

Web search used to run as a fourth process on its own port. It is now served
by the file server itself, so there is one fewer listener, one fewer port,
and one fewer thing to reason about. `GEMMA_SEARCH_PORT` is ignored.

Only the web UI port is opened to the LAN. llama-server and the embedding
server bind `127.0.0.1` and are reached through the file server's proxy,
which is behind the password -- so `setup-lan.bat` now creates a firewall
rule only for the web UI and deletes the older rules for the others.

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
address you used. `PURGE.md` has the full procedure.

In the app, **Data → PURGE ALL** clears this browser's copy: threads,
characters, personas, macros, and the cached embeddings and retrieval
telemetry derived from them. It reports anything it could not clear rather
than claiming success.

One residue is genuinely unreachable, and it is worth stating rather than
implying: a phone or tablet that connected to the chat keeps a full copy in
its own browser storage, and nothing on this PC can reach it. There is no
push channel, and at uninstall time the server is being shut down. Clear
each device while you still have it.

---

## Remote images are opt-in

A character card can hold its picture inline, or hold a web address pointing
at one. The second kind is fetched by your browser when a message renders,
which tells that server your IP address — no click required, and a card can
arrive from an import or a synced peer.

From 1.5.9 those are **off by default** and gated behind Settings → *Allow
remote images*. Inline pictures (`data:`) and locally created ones (`blob:`)
always work and never touch the network. `file:` URLs are dropped entirely;
a page served over http cannot load them, so they never worked here.

One rule covers avatars, card backgrounds and attachment thumbnails alike.

## The render path

Values that reach the page — character ids, thread names, macro triggers,
filenames from model output, colours from a card — are treated as untrusted
regardless of where they came from, because any of them can arrive from an
imported card, a synced peer, or the model itself.

Worth knowing if you are reading the code: HTML-escaping alone is **not**
sufficient inside an inline event handler. The HTML parser decodes character
references in an attribute value before the JavaScript is compiled, so an
escaped `&#39;` becomes a real quote again and closes the string. Values
going into handlers are escaped for the JavaScript layer first and the HTML
layer second. Colours are allowlisted rather than escaped, because escaping
is the wrong tool for a CSS context.

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
