# v1.7.2 — README corrections

*Closes #16. Thanks to @TheAmericanMaker, who measured every claim before
filing and dropped one of their own findings after re-checking it.*

---

## What the PR reported

Three README lines that `SECURITY.md` contradicts, plus a missing `.gitignore`
entry. Each was re-checked against the code here rather than taken on trust.
All three hold.

### 1. `.jobs/` not ignored — already fixed

`fileserver.ps1` spools each generation there and the `.sse` file holds the
reply transcript, so a stray `git add -A` would commit chat output. Already
present in `.gitignore` at line 35, with a note that the Go server keeps job
spools in memory and the ignore is for the PowerShell path. Nothing to do.

### 2. "your password never leaves your computer" — wrong

`internal/server/server.go` reads it with `r.PostFormValue("password")` over
plain HTTP. Signing in from a phone puts the password on the LAN in the clear,
and `internal/auth/login.go` already tells the user exactly that on the sign-in
page. The README was the only place claiming otherwise.

Now says the password is never *written down* in readable form — which is true,
and is what `SECURITY.md` actually claims — and states plainly that signing in
from a phone sends it across the network unencrypted, with the reason that
matters: do not reuse a password from elsewhere.

### 3. "never needs the internet" — has an exception

`js/19-extensions.js` sets `script.src` and `link.href` from a user-supplied
URL with **no host restriction**, so an extension can be loaded from anywhere on
the public internet. Verified in the code, as the reporter found by running it.

Now scoped to the AI itself, with the two things that do reach out named — web
search and URL-loaded extensions — and both marked as off unless the user turns
them on.

### 4. "identifying metadata and telemetry are stripped from your searches"

True, and silent about what *does* leave. Verified: the relay drops the session
cookie and login token before the hop, and forwards the query body and the
user's Ollama key to `ollama.com`.

Now says both halves: what is dropped, and that the search text and the key go
out, because that is what a search is. Adds that chat messages never do, since
that is the question the sentence is really being asked.

---

## One thing the report could not have caught

The measurements were taken against **1.5.8**, where `fileserver.ps1` builds a
fresh header set for the search hop:

```powershell
$headers = @{ 'Content-Type' = 'application/json' }
```

Anything the browser sent — `User-Agent` included — is absent by construction.

1.7's Go relay works the other way round. `internal/proxy/proxy.go` deletes a
list from the inbound headers:

```go
r.Out.Header.Del("Cookie")
r.Out.Header.Del("X-Gobbonet-Token")
r.Out.Header.Del("X-Forwarded-For")
```

Everything not on that list is forwarded, and `User-Agent` is not on it. So the
browser's user-agent string — browser, version, OS — now reaches `ollama.com`,
where on 1.5.8 it did not.

**Not changed here.** It is a behaviour change to shipped code, not a README
fix, and it deserves its own decision rather than being folded into a
documentation pass. The wording chosen above is accurate either way: it claims
only what the code verifiably does — the session cookie and login token are
dropped — rather than the broader "identifying metadata is stripped", which
1.7 no longer fully earns.

The fix, if wanted, is one line next to the existing deletes: set `User-Agent`
to a constant rather than deleting it, since Go's transport substitutes
`Go-http-client/1.1` for an absent one, which is its own fingerprint.

---

## Also corrected, found while checking the rest

**The example model menu** was showing a 16 GB model recommended for a 16 GB
card — the exact overcommitment fixed in the VRAM work. It also had a model
that is no longer in the catalogue (`Gemma 3 4B IT`), stale sizes, and wrong
tier headers. Replaced with the real menu, and a short note on *why* the 16 GB
card is not offered the 16 GB model, since that is the part users get wrong.

**"Some models using the Tekken tokenizer misbehave"** in Known bugs was the
Cydonia problem. Fixed, and confirmed working by the maintainer. Moved to a new
"Recently fixed" subsection with a plain-language account, rather than deleted —
someone who hit it will search for the symptom.

**"Mistral — hit and miss"** in Working models, same reason. Now "working".

**The `502` troubleshooting entry** told users to go hunting for Ollama. Since
the landing page learned to report the engine's own error, the first move is to
read it. Ollama demoted to the fallback it now is.

**The source-tree diagram** listed 15 CSS files where there are 17, and omitted
four scripts that ship with the ZIP. Updated, and `docs/` and `tests/` added.

**The `fonts/` 404** the reporter noticed on a source install: documented rather
than fixed. It is deliberate — `css/01-tokens.css` uses `font-display: swap` and
falls through to a system monospace, and the font is left out of the repo so
GobboNet never fetches one from a CDN at runtime. Worth saying out loud, since
a 404 in the console looks like a defect.

---

## Files changed

| File | Change |
|---|---|
| `README.md` | Three privacy claims corrected; model menu, known bugs, working models, 502 advice, source tree, fonts note |

No code changes. `.gitignore` already had the fix.
