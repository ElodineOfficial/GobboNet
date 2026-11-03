# RAG System Info

- **Dump this file into an AI, have it re-write your notes to be optimized for GobboNet. Or alternatively, just dump plain text into the RAG field and it'll work just fine!**


# Gobbonet RAG Storybook — How to Use It

A plain guide for the person *authoring* a storybook. (The design doc this is drawn
from is an engineering spec; this is just the part you actually touch.)

---

## The short version

You write your whole character/world bible into **one field** called **RAG Storybook**,
in either of two ways — or both, in the same field. Only the entries the current scene
touches go into the prompt, so a 40KB cast costs you only the slice a scene needs.

**1. Just write it.** Plain text works, with nothing else to learn:

```
Selah is an angel wandering the world as a human. He sometimes holds a light ethereal
glow to him, but he never would simply show his wings. He is relatively indifferent to
most things and tries not to get involved in human affairs. Some of his friends in town
call him ‘Neighbor’.
```

Every **four sentences** is an entry (a blank line also starts a new one). An entry is
pulled in when the conversation:

- **names someone or something in it** — *Selah*, *Neighbor*. A name is any word written
  with a capital letter that is not just starting a sentence; or
- **mentions one of its distinctive words** — *angel*, *light*, *wing* above — the way
  lorebooks usually behave. Common words (*never*, *things*, *people*) never count, and
  a word that several entries share counts for less (two entries sharing *angel*: it
  takes another of their words as well).

Want it more specific? Under the field, **Plain text fires on** asks for **2** or **3** of
an entry's words instead of 1. A name still pulls its entry in by itself. This is per
character, so a small companion can stay at 1 while a big world bible asks for 2.

This works **without the embedding model**. When the embedding model is running, entries
are also matched by meaning, so a scene about a winged stranger can pull Selah in
without naming him.

**2. Label it.** For control over exactly what fires an entry:

```
# Selah, [.7 wing, .3 light, 1.0 angel]
Sometimes called ‘Neighbor’ by his friends in town, Selah is secretly an angel walking
the mortal realm. He is relatively indifferent to most things and tries not to get
involved in human affairs.
```

- **The header (`# Selah`) is the entry's name and its primary trigger.** Saying "Selah"
  fires it.
- **The bracket holds weighted tags,** each weight between 0.0 and 1.0. The entry also
  fires when the tags found in the conversation **add up to 1.0**:
  - *angel* (1.0) fires it alone;
  - *wing* + *light* (0.7 + 0.3) fire it together;
  - *wing* alone (0.7) does not.
- **Everything under the header, up to the next header or a `---` line, is the entry.**
  Keep it to about four sentences.
- **The model never sees the header line, the tags or the weights.**

Weights can be written either way round — `.7 wing` or `wing [0.7]` — and a tag with no
number is 1.0. `# Selah [wing (0.7), angel]` and `# Selah: [.7 wing, 1.0 angel]` work
too. Matching ignores plurals and simple endings: *wing* matches *wings*, *Selah*
matches *Selah's*.

The line under the field shows how your text was read, for example **read as → 1 named
entry: Selah (3 tags) · 4 plain-text entries**. If a header did not take, it is not in
that list.

The rest of this page is the power-user layer: more control lines under a header,
relations between entries, and the global knobs.

---

## Where it lives, and what goes where

In the card editor you'll see two fields. They are not redundant — they behave
differently:

| Field | Size | When it's used | What to put there |
|---|---|---|---|
| **Starting Lore** | small | **always present** every turn | scene setup, the premise, background the model should *always* have |
| **RAG Storybook** | large | **pulled on demand** | the full cast/world bible — characters, places, relationships, lore entries |

Rule of thumb: if the model needs it *every* turn, it's Starting Lore. If it's a big
reference body where only the relevant bit matters at any given moment, it's the
Storybook.

As you type into the Storybook, a live readout shows how your text was read — **read as →
2 named entries: Selah (3 tags), reinhard · 5 plain-text entries** — so you can see which
lines became named entries with tags, and how much was taken as plain text.

---

## Writing structured entries

A structured entry is a set of lines prefixed with an **entity name** and a **reserved
suffix**. The suffix tells the system what the line is for:

| Suffix | What it does |
|---|---|
| `*_tags` | weighted trigger terms — the keywords that cause this entity to fire |
| `*_relation_*` | a graph edge to another entity (used for one-hop expansion) |
| `*_role_in_arcs` | a priority hint so the ranker favors plot-important entities |
| `*_use_*` / `use_principles` | render/behavior notes that ride along with the entity but are **never** searchable text |
| `*_offscreen_default` | marks the entity as suppressed — it won't fire on a passing theme alone |

### Entities and sub-threads

You can attach tags at two levels:

- **Entity** — the whole character/place, e.g. `reinhard`.
- **Subtree** — a facet of that entity that can surface on its own, named with a dot:
  `reinhard.marguerite`.

This matters because a subtree can be pulled in **without** dragging in the whole
parent. Reinhard himself can be offscreen, but his "dying companion Marguerite"
sub-thread can still surface when the scene calls for it — and you only pay for that
small slice, not his entire bio.

### A complete example

```
# --- Selah: a central character, always relevant when her themes appear ---
selah_tags: angel [1.0], divine [0.8], heaven, winged [1.0], halo [0.5]
selah_relation_mentor: reinhard
selah_role_in_arcs: protagonist
selah_use_principles: speaks formally; never drops the celestial register

Selah is a fallen-then-redeemed seraph who guards the gallery at night. She is
proud, lonely, and quietly afraid of being forgotten. (This freeform prose gets
embedded for semantic retrieval — it's what the model actually reads when she fires.)

# --- Reinhard: present in the world, but offscreen by default ---
reinhard_tags: scholar [1.0], collector [0.7]
reinhard_offscreen_default: true

# --- a sub-thread of Reinhard that can surface by itself ---
reinhard.marguerite_tags: dying companion [1.0], failing [0.6]
reinhard.marguerite_use_principles: render only the grief, not Reinhard's full bio
```

---

## The weight system — the part you'll actually tune

Every tag carries a **weight**, and the default is **1.0**. A bare tag with no bracket
is just weight 1.0:

```
selah_tags: angel [1.0], divine [0.8], heaven, winged [1.0], halo [0.5]
                                       ^^^^^^
                              this is the same as  heaven [1.0]
```

You only ever write a weight to do one of two things: **turn a noisy term down**
(`divine [0.5]`) or **emphasize a strong one**. Leave everything else at the default.

### How firing works: weight-sum, not count

A thematic pull fires when the **summed weight of the matched tags ≥ the fire
threshold** (default `1.0`). It's not about how many tags matched — it's about their
total weight.

Worked example, at threshold `1.0`:

- `divine [0.5]` matches alone → sum is **0.5** → **does not fire** (below 1.0)
- `divine [0.5]` + `winged [1.0]` both match → sum is **1.5** → **fires**

This gives you one dial per tag plus one global threshold, which is far more expressive
than a simple "two tags matched" rule.

### Identity tags (no special mechanism needed)

An "identity" tag is just a tag whose weight is **≥ the threshold**, so a single match
fires the entity on its own. `angel [1.0]` at threshold `1.0` fires Selah from one hit.
Use this for a character's defining trait or name. There's nothing extra to configure —
it's the same weight system.

### Offscreen suppressors (keeping characters from butting in)

Add `*_offscreen_default: true` to an entity and it **won't** fire on a passing theme.
It only comes in when an identity tag or an explicit trigger hits. This is how you stop
a minor or absent character from lighting up every time their general theme drifts past.

The veto is real, not just a down-rank — a suppressed entity gets dropped even if its
theme scored well. But as shown above, a **subtree** of a suppressed entity can still
surface independently.

---

## What the model actually receives (so the brackets don't worry you)

Important: the `[weight]` syntax and the tag lines themselves are **control data, not
narrative**. They are parsed out when the card loads and are **never sent to the model**.

When an entity fires, the model sees its **descriptive prose and use-principles** — not
its tag list, not the weights. So:

- You don't need to hide or strip anything in normal use; the brackets never reach the
  model.
- The one thing to avoid: **don't hand-type weight annotations like `[0.8]` into a
  prose field.** Keep the `[n.n]` syntax confined to `*_tags` lines. (Brackets in story
  prose — stage directions, `[redacted]`, dice notation — are left alone, which is why
  the system won't blanket-strip them.)

In other words, you're not writing the literal prompt. You're authoring a well-tagged
library, and the system assembles the right slices into the prompt for you.

### Where the slices go: CONFIG > Prompt Order (1.7.8)

By default the pulled slices sit near the top of the prompt, with the character and
the lore. **Put lorebook snippets just before my newest message**, in CONFIG, moves
them down:

1. character and lore
2. the conversation
3. lorebook snippets
4. your new message

Why it matters: llama.cpp keeps the last prompt it read and only reads again from the
first point where the new one differs. The slices change from message to message, so
near the top they make it read the whole conversation again every time. Near the end,
only the last exchange is new. In a long chat that is most of the work the graphics card
does before a reply: in a test chat, 99% of the prompt was read again each message
with them at the top, 4% with them at the end.

The same slices reach the model either way; only their place changes, and a model may
lean on them a little differently near the end. It is off by default, and can be preset
for every browser with `retrieval_near_end = true` under `[ui]` in `config.toml`.

---

## The two global knobs (settings, not per-tag)

Beyond per-tag weights, two settings shape overall behavior:

- **`fire_threshold`** (default `1.0`) — the bar a weight-sum must clear to fire.
  Raise it → fewer, only-strong pulls. Lower it → more pulls, with a risk of flooding
  the context.
- **`warmth_turns`** — once something fires, it stays "warm" for this many turns so it
  doesn't flicker in and out of the scene turn-to-turn. Also `expansion_depth` controls
  how far relational expansion reaches (default one hop along `*_relation_*` edges).

When tuning, change **one knob at a time**. Per-tag weights are your fine adjustment;
the threshold is your coarse one.

---

## Tuning in practice

1. **Author, watching the parsed readout.** Confirm structured lines parsed as tags and
   prose parsed as chunks.
2. **Lean on the semantic backstop.** Tagged entities are *also* scored semantically, so
   an allusive scene (the theme is present but no tag word appears) can still surface the
   right character. You don't have to enumerate every synonym as a tag.
3. **Fix noisy tags in the card, not in code.** If a term keeps firing when it
   shouldn't, lower its weight (`divine [1.0]` → `divine [0.5]`). The weighted-tag Pareto
   view (fire frequency × weight per tag) is where you spot which terms to re-tune.
4. **Remember the reliable path.** If the embedding server is ever down, semantic
   retrieval quietly switches off, but names, weighted tags and plain-text entries'
   words keep working. Since 1.7.9, plain text does not depend on the
   embedding model being available.

---

## Memory files: notes a character keeps (1.7.8, issue #41)

Below the Storybook in the card editor is **Memory Files**: `.md` (or `.txt`) notes the
character reads back when they matter. Use them for things that are *files* rather
than a bible: a quest log, a journal, a running list of what happened, notes the
character wrote itself.

- **Getting a file in.** **+ IMPORT .MD** in the editor, or — the loop the issue asked
  for — when the character writes a ` ```file:notes.md ` block in a reply, that block
  has a **Save to memory** button next to Save. Saving a file with the same name again
  asks, then replaces it, so a character can keep one file up to date. **SAVE** in the
  editor keeps imports and removals; **CANCEL** drops them.
- **How it is read.** Each file is split at its own headings (`#`, `##` …), then into
  paragraph-sized parts. They join the same semantic pool as Storybook prose, and only
  the parts that match the recent conversation are injected, labelled with where they
  came from:

  ```
  [Memory file: quest-log.md › Quest log › The mill]
  The silver key is hidden under the third floorboard of the old mill.
  ```

  One more short line tells the model which memory files it has and how to rewrite one.
  A card with no memory files gets neither.
- **Why not paste into the Storybook?** The Storybook reads a `# heading` line as a new
  *entity*, and nearly every Markdown file starts with one. Memory files keep their
  headings as headings.
- **Without the retrieval model.** When the embedding model isn't running (or
  Retriever A is switched off), memory files are matched by shared words instead —
  a part needs at least two distinct words in common with the conversation. Storybook
  plain text has its own version of this: names, and two distinctive words.
- **Limits.** Up to 20 files per character, 100,000 characters each, 400,000 in total.
- **Where they go.** With the card: its PNG/JPG exports and imports, character and full
  backups, and device sync. A shared card's files are checked on the way in (names
  only, never paths; text only; within the limits). Nothing about them leaves this
  machine except through an export you make.

---

## One-page cheat sheet

- **One input:** RAG Storybook, written two ways:
  - **plain text**: every four sentences is an entry; it fires on a name in it or one
    of its words (2 or 3 if you set **Plain text fires on**), and on meaning with the
    embedding model;
  - **labelled**: `# Selah, [.7 wing, .3 light, 1.0 angel]` then the entry. The name
    fires it, and so do tags adding up to 1.0.
- **Always-on vs. on-demand:** Starting Lore is always present; the Storybook is pulled
  only when relevant.
- **Tag syntax:** `# Name, [.7 term, 1.0 term]` on the header, or
  `name_tags: term [weight], term, term [weight]` — weight first or last, default `1.0`.
- **Firing:** sum of matched tag weights ≥ `fire_threshold` (default `1.0`).
- **Identity:** any single tag at weight ≥ threshold fires on its own.
- **Suppress:** `name_offscreen_default: true` blocks passing-theme pulls; subtrees can
  still surface.
- **Subtrees:** `entity.facet_tags: …` lets a facet fire without the whole parent.
- **The model never sees tags or weights** — only the fired entity's prose. Keep
  `[n.n]` out of prose fields.
- **Tune:** weights = fine, `fire_threshold` = coarse, one knob at a time.
- **Memory files:** `.md` notes on the card, split at their headings, retrieved like
  Storybook prose (shared words when the embedding model is off). **Save to memory**
  on a ` ```file:name.md ` block keeps what the character wrote.
