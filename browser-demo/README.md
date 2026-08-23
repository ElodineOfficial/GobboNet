# GobboNet in the browser

GobboNet running a real language model **inside the tab** — no install, no
server to run, no account. Open the page, approve the download once, and the
model generates on your own hardware.

This page is static. GitHub Pages serves HTML, CSS and JavaScript; there is no
backend behind it and nothing to sign into.

---

## Where the model comes from

The weights are **not** in this repository — they are several hundred megabytes
and they are not ours to redistribute. They are downloaded by your browser, on
first use, from PrismML's own published models:

| what | from | size |
|---|---|---|
| Bonsai 1.7B (Q1_0) | `huggingface.co/prism-ml/Bonsai-1.7B-gguf` | ~236 MB |
| mirror, if HuggingFace is unreachable | `weights.aitherium.com` | same file |

The mirror is a fallback, tried only if the primary fails. Set
`NEXT_PUBLIC_BONSAI_MIRROR_BASE=none` to disable it, or point it at a copy you
host yourself.

The download happens **once**. The browser caches it, so a second visit starts
without re-downloading.

## Where the engine comes from

The inference engine — the WebGPU compute shaders that actually run the model —
loads from `gobbonet.aitherium.com` rather than being copied into this repo.
The two files in `workers/` are ten-line loaders, not the engine.

That is deliberate, and it is better for this repo: a copied engine would be
**frozen** here, so a kernel fix could never reach you, and it would not make
the demo self-contained anyway — the weights come from elsewhere regardless.
Loading the engine from one place means you always run the current one.

To self-host it, change the URL in either loader. Nothing else depends on it.

---

## What leaves your machine, precisely

This is worth stating exactly rather than in a slogan, because "nothing leaves
your machine" would not be true in every case.

**Your conversation is generated on your device.** When you type a message, the
text goes to a Web Worker in your own tab, the model runs on your GPU (or CPU),
and the reply comes back. **No server is involved in generating it** — not
GitHub's, not ours. Turn off your network after the model has loaded and chat
still works.

**What GitHub sees:** the ordinary web-server record of you fetching a page —
your IP address, your browser's User-Agent, which files you requested. The same
thing any static site sees. It never receives your messages, because your
messages are never sent anywhere to be answered.

**What we see:** the requests for the model file and the engine file. Those are
downloads of *our* content — they carry no conversation, no prompt, no
identity.

**The exception — tools.** If the model calls a tool (web search, deep
research, saving a note), *that* request goes to `portal.aitherium.com`, and it
carries whatever the tool needs — a search query, for instance. That is what a
tool is: a request to something outside the tab. Several tools are switched off
on this page entirely (`open_app`, `list_apps`, `search_knowledge`,
`generate_image`), and chat works fully without any of them.

**Verify it rather than believe it.** Open DevTools → Network and use the page.
You will see the model download, and a tool request if a tool runs. You will
not see your conversation posted anywhere for a reply — because it never is.

---

## Consent

Nothing downloads until you say so. The dialog names the size before any bytes
move, and the choice is remembered only if you tick the box. Phones are
size-capped: a device that would be killed by a large model is told so up front
rather than after a long download.
