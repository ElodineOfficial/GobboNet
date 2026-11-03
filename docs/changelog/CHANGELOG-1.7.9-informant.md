# 1.7.9 — The Gobbonet Informant, rewritten for 1.7.9

*Patch step 15 of 1.7.9, F5. Done last, so it describes 1.7.9 as shipped.*

## What was happening

- **Written for older versions.** The Informant, the built-in guide character
  in `default-characters.json`, carried 7,248 characters of notes from before
  1.7. Some of it was wrong for 1.7.8:
  - right-click menus on chats (they are buttons on each row);
  - "Del: no undo";
  - one master switch for mods;
  - a periodic personality reminder (it is sent with every reply now);
  - "search is the only thing that uses the internet".
- **Missing features.** It knew nothing of the CONFIG sections, the catalogue,
  phones, memory files, or anything 1.7.9 adds.
- **No rule against guessing.** It was told to say it didn't know, but only in
  its last line, and its temperature (0.5) let small models wander.
- **An old copy stayed old.** A user who had added the Informant could never
  get a newer one: + ADD answered "already in your character list".

## The change

**A new Informant.** It is 4,890 characters and about 1,560 tokens on a
Mistral tokenizer (1.7.8's was about 1,920), and covers:
- getting around and the tour;
- chats, messages, attachments and web search;
- UNDO;
- characters, personas and macros;
- models: the catalogue, its filters, Unverified, FOUND ON THIS COMPUTER;
- the CONFIG sections and setting search;
- phones;
- mods and endorsed mods, including `?nomods`;
- DATA, SCHED and privacy.

It names buttons exactly as they appear on screen, and follows a rule:

> Answer only from the notes below. If they do not cover it, say: "I don't
> know that one. Check TROUBLESHOOTING.md in the GobboNet folder, or ask
> Elodine (GobboNet's creator) on Discord." Never guess or invent a button,
> setting or step.

The rule is stated first and again last, where small models weigh it most.
The personality, which is sent with every reply, repeats it. Temperature
drops to 0.3.

**UPDATE for default characters.** On the home screen each default character
says one of three things:
- **+ ADD**: not added yet.
- **ADDED**: you have it, as shipped.
- **UPDATE**: you have it, but its prompt differs from the version shipped now.
  - Clicking replaces the prompt text and the sampler values the default ships
    with.
  - The card's id, avatar, colours, background, banned phrases, memory files,
    custom code and carousel lines are kept.
  - UNDO puts the card back exactly as it was.

Clicking ADDED does nothing, instead of the old blocking alert. A card you
edited yourself also shows UPDATE. The badge only offers it; nothing changes
until you click.

**Stale notes in the page, found while checking every claim:**
- The Personality hint said "Injected periodically as a reminder". It now says
  it is sent with every reply, which is what `buildContextMessages` has done
  since the reminder was removed.
- The web search key's "?" note described the search proxy on :11435 that
  1.6.0 removed.
- Privacy Status said only web search and the model list go online. It now
  counts the endorsed mod list (step 14).
- TROUBLESHOOTING pointed at "CONFIG > Config File"; since step 10 it is under
  Advanced.

## Tests

- `tests/test-informant.mjs`, 52 checks:
  - **The card loads:** it has a low temperature and says it describes 1.7.9.
  - **Budget:** under 1,500 tokens by the app's own `estimateTokens`, leaving
    2,500 of a 4,096 context.
  - **Coverage:** every 1.7.9 feature by name.
  - **The rule:** stated first and last, and repeated in the personality.
  - **Every name it quotes exists:** each on-screen name (25) and each
    "CONFIG > …" path in the page or its scripts. This check fails on any
    renamed button.
  - **Every macro exists.**
  - **The old mistakes are gone.**
  - **UPDATE:** run for real. It keeps the user's extras, UNDO restores the
    card exactly, there is no copy and no alert, and the badges show.
  - **The stale notes are fixed.**
- **In Chromium, against the real server and engine:**
  - + ADD, then ADDED;
  - an Informant with the 1.7.8 text showed UPDATE and updated, keeping its
    colour and banned phrases;
  - UNDO restored it;
  - once the UNDO window had passed, the update was still there after a reload;
  - a real chat with the Informant sent the new prompt. The first request was
    1,816 tokens by the engine's tokenizer.
- `tests/console/1.7.9-step-15.js`, 13 checks. It counts the card with the
  loaded model's own tokenizer. It checks UPDATE and UNDO on a throwaway
  character and leaves the user's own Informant alone.

**Not run:** the Informant answering questions on a real chat model. This
workspace has only the tiny test model, which cannot hold a conversation.
