# 1.8.1 — Lore System: an entry of three words or fewer is written again

## What was happening

Lore System writes one entry per compression pass and appends it to the
thread's lore, which is fed back to the model as fact on every later turn. A
small model sometimes answers with a fragment -- "He left.", "Battle
continues", "The end" -- and that was stored like any other entry: a line
that records nothing and stays in the lore for good. Requested: cull an entry
of three words or fewer and write it again.

## The change

In `summarizeForLore` (`js/07-prompt.js`), after the answer has been parsed
and cleaned to one entry (`_cleanLoreBeat`), its words are counted
(`loreEntryWords`). At `LORE_MIN_WORDS` (3) or fewer it is culled and the same
prompt is sent again, up to `LORE_SHORT_REROLLS` (2) more times. Each reroll
runs warmer (temperature 0.55, then 0.8, from 0.3) and adds one line asking
for a complete sentence, because the same prompt at the same low temperature
tends to hand back the same fragment.

- A full entry from a reroll is stored as usual; the outcome names what was
  culled, and the console says so.
- If every try is that short, nothing is stored and the pass is a failed one,
  exactly as for any other pass that writes no entry: a gap marker in the
  lore, and the ⚠ Lore notice in the chat, whose "why?" quotes the entries.
- A reroll the server refuses ends it the same way, with the HTTP status.
- `SKIP` is not counted: it is the model saying nothing happened. An empty
  answer or an echoed template is handled as before.
- Bullets, dashes and bare punctuation are not words. Scripts written without
  spaces between words (Han, Hiragana, Katakana, Thai, Lao, Khmer, Myanmar)
  count each character, or a whole Japanese sentence would be one "word" and
  culled every time.
- Every try shares the pass's existing timeout (`loreTimeoutMs()`), so a pass
  takes no longer to give up than it did.

The custom-prompt tooltip (CONFIG, "Edit the lore summary prompt") lists what
happens to a reply and now says this too; `AGENTS.md`'s memory note and
`PATCH-README.txt` too.

## Tests

- `tests/test-lore-compression.mjs`, section 10 (new), against the real
  `summarizeForLore` with scripted answers: a short entry rewritten and only
  the full one stored, the reroll warmer and told why with otherwise the same
  prompt, the indicator saying so and clearing; three short answers giving
  three requests and nothing stored, quoted in the outcome; four words stored
  at once; bullets and punctuation not counted; SKIP not rerolled; a refused
  reroll; the word count in Cyrillic, Japanese and Thai, a Japanese entry
  stored and a three-character one rewritten. 23 checks; against 1.8.0 the
  first three fail and the fourth throws.
- `tests/test-lore-model.mjs`: its stand-in summariser answered "Summary from
  <model>", three words, which the new rule rightly culls; it writes a full
  sentence now. Its 29 checks pass, as `test-lore-prompt.mjs`,
  `test-lore-editing.mjs` and `test-user-limits.mjs` do.

Not run: a real model writing a short entry (the sandbox has none).
