# 1.7.9 — The RAG Storybook fires, written either way

*A user report against 1.7.9: lore in the RAG Storybook was not being pulled
into the chat.*

## What was happening

The Storybook is meant to take lore two ways:

```
# Selah, [.7 wing, .3 light, 1.0 angel]
Sometimes called ‘Neighbor’ by his friends in town, Selah is secretly an angel
walking the mortal realm. He is relatively indifferent to most things and tries
not to get involved in human affairs.
```

```
Selah is an angel wandering the world as a human. He sometimes holds a light
ethereal glow to him, but he never would simply show his wings. He is relatively
indifferent to most things and tries not to get involved in human affairs. Some
of his friends in town call him ‘Neighbor’.
```

Neither worked. With the embedding model off, which is how most installs run,
neither entry fired for any message, including one that named Selah. The causes
were in `js/08-rag.js`:

1. **The header line was not a header.** The pattern allowed only a bare name,
   so `# Selah, [ ... ]` was read as anonymous prose.
   - Its tags were lost.
   - The weight-first form (`.7 wing`) was not understood anywhere.
   - When the entry did fire through the embedding model, the line
     `# Selah, [.7 wing, ...]` went to the model as part of the lore.
2. **A name was not a trigger.** An entry fired only through its tags. A
   header with no tags could never fire, and saying "Selah" did nothing.
3. **Plain text needed the embedding model.** Storybook prose was found only
   by meaning, through the optional embedding model, and had no other path.
   `docs/RAG_INFO.md` opened by promising that plain text "will work just
   fine".
4. **Plain text was not split into entries.** A paragraph was one chunk, and
   a dump with no blank lines was one chunk the size of the dump.
5. **Tags matched exact words only.** `wing` missed "wings", and `Selah`
   missed "Selah's".

## The change

**Labelled entries.**
- `# Name, [tags]` is an entry. So are `# Name [tags]`, `# Name: [tags]` and a
  bare `# Name`.
- **The name is the primary trigger.** Saying it fires the entry, tags or no
  tags, and also lifts `offscreen_default`.
- **Tags fire it when the weights found add up to the threshold** (1.0 by
  default). `.7 wing` + `.3 light` is exactly 1.0 and fires, whatever floating
  point says. `wing` alone (0.7) does not.
- Weights can be written first (`.7 wing`) or last (`wing [0.7]`,
  `wing (0.7)`, `wing: 0.7`).
- Names can be in any language and contain spaces and hyphens.
- `# Chapter 1: The Fall` (it has a colon) stays prose, so a pasted Markdown
  heading is not mistaken for an entry.
- **The header line and its weights are never sent to the model.**

**Plain text.**
- Every **four sentences** is an entry. A blank line also ends one.
  "Dr. Vale" does not end a sentence.
- An entry fires on a **name** in it, or on **one of its distinctive words**.
  That is how lorebooks usually behave, and it is the default after
  Elodine's review; the first version of this fix asked for two.
  - Names are words written with a capital that are not just opening a
    sentence (*Neighbor*), or capitalised sentence openers never written in
    lower case anywhere (*Selah*).
  - Each distinctive word is a tag. A word only one entry has is worth the
    whole threshold, a word two entries share half of it, and so on. Common
    words (*never*, *things*, *people*) never count.
  - **Plain text fires on** (card editor, under the field) asks for **2** or
    **3** of an entry's words instead, per character: a small companion can
    stay at 1 while a big world bible asks for more. It is saved on the
    character (`ragWordsToFire`, 1 to 5, default 1) and travels with an
    exported card. A name fires its entry whatever it is set to.
  - At most top-k entries fire on words alone, strongest first. A name always
    fires its entry.
- **This works without the embedding model.** With it running, entries are
  still matched by meaning as well.

**Matching** is on whole words with light stemming, so *wing* matches
*wings* and *Selah* matches *Selah's*. This applies to tags, names and plain
entries alike.

**The editor** shows how the text was read, for example **read as → 1 named
entry: Selah (3 tags) · 2 plain-text entries**. The field's example and its "?"
note show both ways. A plain entry reaches the model labelled `[Storybook]`
instead of an internal id such as `[Storybook: doc:3]`.

**Unchanged:**
- flat `name_tags:` lines;
- `# name` followed by bare `tags:`, `relation:`, `role_in_arcs:`,
  `offscreen_default:` and `use_principles:`;
- `[name]` and `== name ==` headers, subtrees, relations, warmth, the budget
  and the threshold setting.

`# Selah` and `selah_tags:` are now the same entry whatever the case. Before,
they were two.

## Also fixed: saving a character threw an error

Step 9 gave deleting a character an UNDO. The same line,
`if (_card) _offerCardUndo(...)`, was also inserted at the end of `saveCard`,
whose closing lines look alike, and `_card` does not exist there. Every save of
a character since then ended in a `ReferenceError` in the console. Nothing was
lost, because the save itself had already happened by that line. The line is
gone. `tests/test-undo.mjs` now checks that saving offers no UNDO, and that
every UNDO helper is handed variables its own function declares.

## Tests

- `tests/test-rag-storybook.mjs` (new), 61 checks. It runs the real parser
  and retriever with the embedding model off and with a stand-in for it:
  - every way of writing a weight;
  - every header form;
  - the header line kept away from the model;
  - firing by name, by tags at exactly the threshold, below it, and stemmed;
  - the threshold setting;
  - plain text: entry splitting, names and openers, word tags, name firing;
    one word firing by default; 2 and 3 words when set, with a name firing
    whatever the setting; a shared word counting half; common words never
    firing; a ten-sentence dump becoming three entries, each pulled alone;
  - the setting in the editor, saved, loaded and exported;
  - every older form, offscreen suppression and relations;
  - matching by meaning on top;
  - the readout, the field's example and the guide.
- `tests/test-memory-files.mjs`: one check had pinned "storybook prose never
  fires without the embedding model", the reported bug. It now checks that
  storybook prose fires on its own path, not the memory-file fallback.
- **In Chromium, against the real server and engine:**
  - the storybook typed into the card editor showed "1 named entry: Selah (3
    tags) · 2 plain-text entries";
  - the character saved with no error;
  - naming Selah sent his entry with no header or weights;
  - wing + light fired it and wing alone did not;
  - a name, one word, and (set to 2) two words each pulled the right plain
    entry, labelled `[Storybook]`;
  - an unrelated line pulled nothing.
- `tests/console/1.7.9-rag-storybook.js`, 13 checks. It changes nothing: the
  storybook lives on a card object that is never saved.

**Not run:** the real embedding model (Nomic). Matching by meaning is
unchanged and was tested with a stand-in.
