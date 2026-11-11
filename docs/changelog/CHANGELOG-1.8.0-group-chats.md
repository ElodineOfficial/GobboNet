# 1.8.0 — Group chats

Several characters in one conversation, taking turns, as SillyTavern and the
front ends that follow it have: a group is a set of character cards with a
turn order, optionally with a place in it for you, and optionally with a DM
that decides who is best to respond.

## What was there

A chat belonged to one character. Since 1.7.9 each message records who wrote
it, so switching the active character mid-chat already showed the right face
on each reply; but only the active character ever answered, it was told
nothing about anybody else, and everything the others had said reached it as
its own words.

## The change

**Two buttons where there was one.** The sidebar's `+ NEW_THREAD` is now
`+ THREAD` and `+ GROUP`, side by side. `+ GROUP` lists the groups to start a
chat with, then "New group…" and "Manage groups…"; with no groups yet it
opens a new one in the editor. The home screen lists YOUR GROUPS once there
are any, and a group chat carries 👥 in the sidebar.

**A group is managed like a character card.** // CHARS has a GROUPS section
between the characters and the personas: a tile per group with its members'
faces, Chat, Edit, Copy, Save (a file) and Del (with UNDO), and arrows to
reorder. The editor has:

- a name, and an optional picture (left empty, the members' faces);
- the members, top to bottom in the order they speak, with arrows to move a
  row, a mute box and × to remove; "Choose a character…", + ADD and ADD ALL.
  Up to 24;
- "Give me a place in the turn order": a You row appears among the members
  and moves like one. A round then stops when it reaches you;
- who speaks next (below);
- replies per round (0 is everyone once), and whether the same character may
  speak twice in a row;
- a scene, given to every member with each reply on top of that character's
  own card;
- how much the members know about each other: names only, a few lines each
  (the start of each Personality; the default), or the whole Personality;
- what a new chat opens with: every member's greeting, the first member's,
  or nothing;
- "End a reply where it starts writing another member's lines" (on).

A member whose character is deleted is skipped and shown as deleted, and
takes its turns again if the character comes back. Deleting a group leaves
its chats: they say the group was deleted, and the active character replies
there from then on.

**Who speaks next.** Five choices:

- *Turn order.* The members in turn, top to bottom, carrying on after
  whoever spoke last. Whose turn it is is never stored: it is read from the
  conversation, so deleting a reply, rerolling, branching and syncing to
  another device all leave it right.
- *Natural.* As SillyTavern's natural order: the members the last message
  names reply first, in the order named (whole words; the first word of a
  longer name counts, so "Captain" finds Captain Reyes); then each of the
  others joins in or not by a talkativeness slider on its row; if that leaves
  nobody, one at random. A member does not answer a mention of its own name
  in its own message.
- *Shuffle.* Everyone once, in a random order, not led by whoever just spoke.
- *DM decides.* Before each reply a short separate request asks the model who
  is best to respond next. It is told who is present with a line about each,
  the scene, the last messages, and whatever "How the DM should choose" says.
  It answers with a name and writes nothing into the chat. With you in the
  order it can hand the conversation back to you. An answer that names nobody
  on its list, a failed request or 45 seconds without one falls back to turn
  order, and the bar says so. Stop works while it is choosing.
- *Manual.* Nobody replies until a member is clicked.

**The bar above the message box**, in a group chat: the group's name (opens
its editor), a chip per member, ▶ NEXT, AUTO, and a line saying whose turn it
is, who is replying ("Bram is replying… (2 of up to 3)") and who is queued.
A chip's name has that member reply now, whatever the order says and muted
or not; its speaker icon mutes or unmutes the member, for every chat with
the group. NEXT, or Enter on an empty message box, has the next member speak
without you saying anything. AUTO has the group carry on by itself: a
finished round is followed by another after the group's pause (5 seconds by
default). It stops when pressed again, on Stop, when typing starts, on
another chat, when a reply fails, and after as many rounds as an
{{auto_continue_N}} chain is limited to; it is never saved.

**A round.** A message from you starts one: members reply one after another
until everyone has (or the group's replies per round, or your place in the
order). Stop, or a failed reply, ends the round with it. REROLL on the last
reply is the same member again. An {{auto_continue_N}} chain sends its next
post after the whole round. A scheduled message into a group chat starts a
round like any other.

**What a member is sent.** One model plays everyone, one member at a time:

- its own card in full, as in a chat of its own, and its own memory;
- a `[Group chat: name]` block: who else is here, with as much about each as
  the group says, you with your persona's description, and the scene;
- the conversation with its own messages as the assistant's and everyone
  else's, yours included, as the other side, each beginning with its
  speaker's name. {{char}} inside a message means whoever wrote it;
- a last line saying whose turn it is and whom not to write for.

The request also carries a stop string for each other name at the start of a
line, so a reply that begins writing somebody else's lines ends there; a
remote server, which may allow only four stop strings, gets none, and the
reply is trimmed afterwards instead. A member's own name label ("Mira: …")
is taken off the front of its reply, while it streams and when it is done.
The group block and the last line are counted in the context budget. Older
messages are folded into the summary with their speakers named.

A member's custom code, and the tools it offers the model, are loaded for
its turn, and the active character's are put back when the round ends. The
context meter and the smart response limit follow whoever is replying.

**What it costs.** A round of four members is four replies. And because
each member's prompt begins with its own card, the prompt changes from its
first lines at every change of speaker: llama.cpp reads the whole
conversation again for each reply, where a chat with one character reads only
what is new. The DM adds one short request before each reply. TROUBLESHOOTING.md
has an entry on it, with what shortens the wait.

**Where groups are kept.** With characters and personas: in the saved state
and its sync to other devices, in DATA's character export and full backup,
and removed by Purge Characters and PURGE ALL. Exporting a group chat includes the
group and all its members; importing a file with groups adds the ones not
already there. A group read from any of these is checked field by field
(`normalizeGroup`): an unknown choice becomes the default and a number is
held to its range.

## Not included

- Writing as one of the members yourself ("send as"), other than by editing a
  reply.
- A model per member. A group chat follows the model it last used, never
  one member's link, since a round would otherwise reload the model between
  replies.
- Members keeping things from each other. Everyone reads the whole
  conversation.

Which of these to take further is the maintainer's call.

Docs: README.md's feature list, TROUBLESHOOTING.md, AGENTS.md, docs/INDEX.md
and docs/PURGE.md. The built-in
Gobbonet Informant's one sentence about the sidebar names the two buttons;
its notes on group chats come with the version bump.

## Tests

- `tests/test-group-chats.mjs` (new, 253 checks): the record through
  `normalizeGroup`, hostile and out-of-range values included; turn order in an
  empty chat, after each speaker, round the end, with muted and deleted
  members, with you at each place; natural order by mention and
  talkativeness, shuffle, replies per round; what the DM is asked and how its
  answer is read, a choice of you, an answer left in the model's reasoning, a
  failed request, Stop; the real `buildContextMessages` for a member: the
  block, roles, names, {{char}}, the cue and the last line, the budget; stop
  strings, tidying a finished reply and a streaming one; greetings; a round
  through to its end with a stubbed reply path, Stop, a failure, reroll,
  reply-now, NEXT, AUTO and its limits, a member's code loaded and restored;
  the bar against a fake DOM, built without innerHTML; names shown as text;
  export, import, backup and purge through the real DATA code; and the
  wiring in chat.html and the reply paths.
- `tests/console/1.8.0-group-chats.js`: in the browser, the page and the
  rules on a made-up group that is never saved; with `GN_GROUP_TEST` set, a
  real round with a group and the loaded model.
- Live, in Chromium against a stand-in engine that logs each request: 43
  checks of the orders, the DM and its fallback, what each member was sent,
  a run-on reply cut, mute, reply-now, reroll, Stop, AUTO, editing, branching
  and deleting a group with UNDO.

The new tests fail on the update button tree.
