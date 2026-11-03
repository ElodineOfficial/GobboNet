# 1.7.9 — Escaping in the render path

*Patch step 4 of 1.7.9. Finishes PR #4 (neoliminal), "Escape values reaching
HTML, inline handlers and CSS in the render path". 1.7.8 already had the PR's
helpers (`escapeJsAttr`, `escapeJsString`, `safeCssColor`, `safeDataUrl`) and
used them on most sinks. These are the sinks that were still open.*

## What was happening

Values from imported files and from the `/state` sync blob are untrusted. Any
paired device, or anyone holding the password, can write `/state`. Seven places
still put such a value into markup or a URL as it was:

| Sink | Value | Effect |
| --- | --- | --- |
| Message header, both render paths (`js/13-dashboard.js`) | the character or persona name | **The PR's headline case.** A card named `<img src=x onerror=...>` ran script whenever its messages were drawn, which also bypassed the switch that keeps imported card code off. |
| Sidebar thread row drag handlers (`js/12-render.js`) | thread id | `ondragstart="onThreadDragStart('${t.id}',...)"` and three siblings. An id with a quote broke out of the handler. |
| Folder header drag handlers (`js/12-render.js`) | folder id | the same, twice |
| Avatar fallback (`js/07-prompt.js`) | first letter of the name | an initial `<` or `&` reached the DOM raw |
| Reply badges (`js/13-dashboard.js`) | `genStartedAt`, `smartCapped` | synced message fields placed in `data-t0="..."` and a `title`, so a string could break the attribute |
| Branch banner (`js/13-dashboard.js`) | `forkSource.at` | "at message N" |
| Lore inspector table (`js/13-dashboard.js`) | `loreLog` counts | `folded`, `before`, `after` put into table cells |
| Job URLs (`js/03-generation.js`, `09-threads.js`, `10-chat.js`) | job id | a synced `pendingJob.id` such as `../../state` walked the URL path of an authenticated POST |

## The change

- Names go through `escapeHtml` at the sink, never at storage. This avoids the
  double-escaped preset icons jmccardle found in the original PR.
- Every id in an inline handler goes through `escapeJsAttr`.
- Synced numeric fields are coerced with `Number(...) || 0` before they reach
  markup.
- Job ids go through `encodeURIComponent` before they reach a URL path.

The audit used a parser over every HTML-building template literal in `js/`,
not only the handler grep, because the header bug sat in a plain `<span>` that a
handler grep cannot see. Everything else it listed was already safe: the
markdown pipeline escapes the whole text before any inline formatting, and the
math-fence language is an anchored allowlist.

## Tests

- `tests/test-render-escaping.mjs`, new:
  - a source lint: every `${...}` in an inline `on*="..."` handler must be
    escaped or a numeric index;
  - each sink above is pinned;
  - every `${JOBS_URL}/${id}` is URI-encoded;
  - the real `renderAvatar` and `escapeJsAttr` are run against break-out
    payloads. The handler must receive exactly the original string after the
    HTML and JS layers both decode it.

  On the 1.7.8 JS it fails 9 checks.
- `tests/console/1.7.9-steps-4-6.js`, in the browser:
  - a hostile thread row is parsed in an inert `<template>`, and each handler is
    compiled with stand-ins to prove it receives the id as one string;
  - a hostile conversation (name, persona, branch banner, badges, lore log) is
    drawn for real, then the page is redrawn from the user's data.

  The payloads only set a flag. On the patched build the block passes 14 of 14.
  On 1.7.8 the step-4 checks fail and the payload runs.

**Not run:** a phone browser.
