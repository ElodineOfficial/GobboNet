# 1.8.0 — The Files panel

A panel on the right of the chat for the conversation's files, as other chat
front ends have one: Claude's artifacts, ChatGPT's canvas, and the artifacts
panels in Open WebUI and LibreChat.

## What was there

Characters could already write a file: a ```file:name block in a reply
renders as a box with Copy, Save and, for Markdown and text, Save to memory.
But a file lived only where it was written. A long one filled the chat, a web
page could not be seen as a page, and asking for a change meant scrolling to
find the last version and comparing by eye.

## The change

**The panel.** The 📄 button in the top bar, with a count, opens it beside the
chat. It lists every file in the conversation, the most recently written
first, and opens one whole. Drag its left edge to resize it (or focus the edge
and use the arrow keys; a double-click resets it); the width, and whether it
was open, are remembered on this device. Below 900 pixels it covers the chat
instead, with × to close.

**What counts as a file.** Nothing new is stored: the panel reads the
conversation as it stands, as the chat shows it -- the version of each
message on screen, with {{char}} and the other names filled in.

- A ```file:name block in any message. The same name written again (in any
  case) is the next version of the same file.
- A text file attached to a message. Your own edited version enters the
  conversation this way, so it becomes a version too, "attached by you".
- A plain ```html or ```svg code block, which can be previewed, listed as
  untitled-1.html and so on. These code blocks get an Open button in the chat.

The panel finds blocks with the same scanner the chat renders with:
`mdExtractFences` became `mdScanFences`, shared, and each rendered block
carries its place among its message's fences as `data-fence`. So the Open
button on a block, and SHOW IN CHAT in the panel, always mean the same block.

**One file.** Its versions, with arrows (‹ v2 of 3 ›) and who wrote each.
Markdown opens rendered, by the chat's own renderer; CSV and TSV as a table
(the first 500 rows); HTML and SVG as a preview; anything else as highlighted
code. PREVIEW and CODE switch between them. COPY, SAVE (download), SHOW IN
CHAT (scrolls to the block and lights it up), and SAVE TO MEMORY for Markdown
and text, which keeps that version in the character's memory as the chat's
own button does.

**Previews cannot reach anything.** An HTML or SVG file previews in a frame:

- sandboxed without allow-same-origin, so the page runs as nobody, with no
  cookie, no session and no way into GobboNet's page;
- under a Content-Security-Policy put first in the document, after the
  doctype and before anything of the page's own, that allows nothing from
  anywhere: no fetch, and no scripts, styles, pictures or fonts from the
  internet. That matters beyond privacy: GobboNet's own server answers CORS
  `*`, so on an install with no password a page that could fetch could read
  the chat history. In Chromium, a test page with scripts running could not
  read `/state` by either address, the cookie, or a picture from the server;
- with scripts off until RUN SCRIPTS is pressed for that file, unless CONFIG
  says to run them. A meta refresh is taken out. A page that still manages to
  open another address -- a link clicked, a script that redirects -- is
  stopped and replaced with a note, because that is the one thing a policy
  cannot forbid a page outright, and the reason scripts start off;
- FULL SCREEN shows it on the whole screen.

No other app's code is fetched for previews (LibreChat's, for instance, loads
from CodeSandbox by default); everything stays on the PC.

**Editing.** EDIT turns the file into a text box. USE IN MY NEXT MESSAGE
attaches what is in it to your next message under the file's name, replacing
an attachment of that name not yet sent, so the character reads your version
and can write the next; once sent, it is the next version in the panel. ASK
ABOUT THE SELECTION, in CODE or in EDIT, attaches the file and quotes the part
you selected into the message box ("In notes.md, about this part: ...").

**Opening by itself.** A reply that writes a file opens the panel on it, on a
screen at least 1,100 pixels wide, and never over a file being edited. While a
reply streams, an open panel follows the file being written, a few times a
second; a preview waits until the file is finished.

**Folding in the chat.** A file block longer than 24 lines is folded to its
first dozen, with "Show all N lines" and Open.

**CONFIG > Characters & Chat > Files Panel**: open the panel when a reply
writes a file (on), fold long files in the chat (on), run scripts in previews
without asking (off).

**The built-in Assistant and CodeGoblin** now also say "To change a file you
already wrote, write the whole file again with the same name", so an updated
file arrives as a new version. CodeGoblin's tile offers UPDATE to anyone who
added it before.

Docs: README.md's feature list, AGENTS.md and docs/INDEX.md. The Gobbonet
Informant's notes are updated with the version bump.

## Tests

- `tests/test-files-panel.mjs` (new), running the scanner, the panel against a
  fake DOM, and the preview document: the scanner numbers fences as the
  renderer does, quoted, indented, ~~~ and unclosed ones included; the files
  in a conversation, newest first, with versions by the character, you and
  another character, {{char}} filled in, a file being written marked, a
  hostile name kept as text; the policy comes before any of the page, a
  script before <head> included, allows nothing from anywhere, and a meta
  refresh is removed; the frame never has allow-same-origin; CSV quoting;
  the list, a file, its versions, PREVIEW and CODE, SAVE TO MEMORY; scripts
  off until RUN SCRIPTS or the setting; a page that loads a second time is
  stopped; EDIT survives a streaming update, USE IN MY NEXT MESSAGE replaces
  an unsent attachment of the same name; ASK ABOUT THE SELECTION; Open on a
  block opens that version; opening after a reply on a wide screen only, and
  not when switched off; folding; the page, CONFIG and the wiring; two
  innerHTML sinks, both escaping renderers.
- `tests/test-markdown-render.mjs`: the markup allowlist takes `data-fence`
  (digits only), `title` on buttons, and the Open and Show all buttons.
  `tests/test-config-sections.mjs` and `tests/test-prompt-order.mjs` follow
  the new CONFIG box.

The new tests fail on the Auto Reroll tree.
