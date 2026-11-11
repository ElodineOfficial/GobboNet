# 1.8.0 — A chat remembers its model, and a character can name one

Issue #52 (nephitejnf). Roadmap item #10.

## What was happening

GobboNet runs one model at a time, and nothing tied a model to a chat or a
character. Someone who used one model for a story and another for code had to
remember which was which and switch from the model menu every time, and a
character built around one model's style answered with whatever happened to be
loaded.

## The change

**A chat remembers the model that wrote its last reply**, as `thread.model`.
It is written after each reply in local mode (send, regenerate and a reply
collected after a reload), from `/swap-status`, and only when it changes: the
chat's own record is otherwise left alone, so it still goes to the server as an
append rather than a whole re-upload.

**A character can name the model it is meant for**: "Model for this character"
in the character editor, above Compression Model, defaulting to "Whatever is
loaded". It lists the models in the models folder, like Compression Model, and
is saved as `card.preferredModel`. A card file carries it in
`extensions.gobbonet.preferredModel`.

**Opening a chat follows them**, in this order: the chat's own model, then the
answering character's link (for a new chat, or one from before 1.8.0 that has
no model recorded), and otherwise nothing changes. How eagerly is a new setting,
**CONFIG > Characters & Chat > Model Switching**:

- **Ask first** (the default): a one-line bar above the message box, in the
  same style as "Replying as ...": "This chat used Mistral Nemo." with
  **Switch (about 20 s)** and **Not now**. The time is how long the last load
  took, from `/swap-status`; it is left out when the server has not said. A
  swap reloads the model, so it is never a surprise.
- **Switch automatically**: makes the switch without asking.
- **Don't switch**: the loaded model answers every chat.

A new chat made by typing on the landing page and sending does not follow: the
message is already on its way, and a switch would land under it.

**It never ends a reply.** One engine serves every device. A switch the page
makes, from the bar or automatically, goes to `/swap-model` with
`"auto": true`. The server (`Supervisor.SwapAuto`) refuses it with 409 and
`"busy": true` while any request is in flight, checked under the same lock that
starts the swap, so no reply can begin in between. `/swap-status` carries
`"busy": true` for as long as that lasts. The page then says "A reply is being
written right now, on this device or another. Switch to ... when it is done?"
and **Switch when done** watches `/swap-status` every 3 seconds and switches
once nothing is being written. Leaving the chat, Cancel, or 15 minutes ends the
wait. It also never switches under a reply this page is writing, or over a swap
already under way. A swap picked from the model menu has no `auto`, and behaves
as it always has.

**A model that is not installed** is said once per chat per visit: "This chat
used X, which is not installed here, so the loaded model answers." with
**Forget it** (or **Clear link** for a character) and **OK**. The link is kept
unless cleared, because a model on a drive that is unplugged today would
otherwise lose it for good. The character editor shows such a link as
"X (not installed)" with a note; choosing "Whatever is loaded" clears it.

**Remote mode** has no hot-swap, so none of this runs there, nothing is
recorded, and the editor hides its model menu.

## Tenets

- **Private.** Only a file name is stored, synced and exported, never a path:
  no folder of this PC travels with a shared card or a synced chat.
- **Secure.** Both fields arrive in imported cards, backups and synced state,
  so neither is trusted. `isPlainModelFile()` in `js/02-model.js` is the
  page's copy of the server's `models.CheckFileName` (roadmap #4, 1.8.0 round
  2): a plain `.gguf` file name, no separator, colon or control character, at
  most 255 characters. A name that fails it is never offered, saved, imported
  or recorded, and the server checks again. A link only ever matches a model
  already in the models folder; it never downloads anything. The bar is built
  from text nodes, so a name from a model file or a card cannot become markup.
- **Easy.** Pick a model once on the character, or just use a chat: the next
  time it opens, it offers its model back.
- **Power.** Per-chat memory, a per-character link, and three levels of
  automation.

## Tests

- `internal/supervisor/swap_auto_test.go` (new): an automatic switch during a
  reply gets `ErrBusy`, starts nothing and `Status().Busy` is true; it goes
  through once the reply ends; a swap from the menu is not held; names are
  checked before anything else; the route answers 409 with `busy: true` and no
  error phase, and `/swap-status` says busy.
- `tests/test-model-links.mjs` (new, 91 checks), running the real
  `js/02-model.js`: the name rule against the server's; the precedence; Ask
  first's bar, its load time and its buttons; automatic, off, remote, a page
  from a file, already loaded, a reply on this page, a swap under way, a chat
  left while the server was asked; a model not installed (said once, link
  kept, cleared in one click); an imported card naming an absent model leaving
  the loaded one alone; a 409 busy offered as a wait, the wait switching once
  nothing is written, and ending when the chat is left; `noteReplyModel`
  writing only on a change, never mid-swap, never a bad name, never in remote
  mode; and the wiring in the thread, chat, editor, CONFIG and card-file code.
- `tests/test-remote-models.mjs` passes unchanged: the header menu's swap is
  now `runModelSwap()`, shared with the bar.
- `tests/test-config-sections.mjs`: the Model Switching box in Characters &
  Chat.
- `tests/console/1.8.0-round-4.js`: the live checks, on your install.

Not run here: a real model swap, which needs the engine (the console snippet
covers it on your PC).
