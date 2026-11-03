GobboNet 1.7.9

Everything below is in this release. Details for each change are in
docs/changelog/CHANGELOG-1.7.9-*.md.

NEW
- UNDO. Deleting a chat, message, folder, character, memory file, persona,
  macro, mod or server backup happens at once and shows UNDO for 10
  seconds. Ctrl+Z (Cmd+Z) works too, outside a text box. One at a time: a
  second delete makes the first final. Nothing is pushed to your other
  devices while UNDO is offered. PURGE asks first and then offers UNDO too.
  Removing a tag or a scheduled message asks first instead. CLEAR ALL in
  MODS still asks.
- An optional tour. A fresh install is asked once: "Show me around" or
  "Skip". Six stops, one sentence each. A profile that already has
  conversations is never asked. CONFIG > Basics > SHOW ME AROUND replays it;
  [ui] tour_seen = true in config.toml stops the offer on every device.
- CONFIG in five sections -- Basics, Characters & Chat, Model &
  Performance, Devices & Network, Advanced -- with a search box that finds
  any setting by a word from its title, note or "?" text. Nothing was
  removed or renamed.
- More models. Add a Model and the first-run list have sixteen, with
  Llama 3.2 1B, Mistral Nemo 12B, Phi-4 14B, Mistral Small 3.2 24B,
  Gemma 4 31B and Qwen3-Coder 30B-A3B new. Filter by use and by size
  (LIGHT / MEDIUM / HEAVY / MOE). A model with no pinned checksum is marked
  Unverified and needs a second click.
- FOUND ON THIS COMPUTER (issue #12): models already in your HuggingFace
  cache, or in folders you list as model_dirs in config.toml, are offered
  in Add a Model. USE IT links one into your models folder -- no copy, no
  download. scan_hf_cache = false leaves the cache out.
- Mods, each with its own switch and place in the load order. A mod is a
  folder in GobboNet's mods folder (MODS shows where) with a mod.json. Your
  extensions from before 1.7.9 become the mod "My extensions" the first
  time you open 1.7.9 on the PC, switched on or off as they were. Mods are
  added, changed and switched on only on the PC GobboNet runs on; any
  device can switch one off. Mod code no longer travels with synced chats.
- ENDORSED MODS: mods Elodine endorses at goblincorps.com/gobbonet_extras,
  installed with one click. Every file is checked against the SHA-256 the
  list pins; one that does not match installs nothing. A new install is
  switched on once; an update keeps your switch. 18+ mods stay covered until
  you confirm your age, in that browser only. mod_list_url in config.toml
  points elsewhere, or empty switches the list off.
- A mod whose file will not load, or whose script fails as it starts,
  switches itself off with a notice. http://localhost:9066/?nomods loads no
  mods at all, to rescue a page a mod broke.
- The Gobbonet Informant is rewritten for 1.7.9, names every button as it
  appears, and says "I don't know, check TROUBLESHOOTING.md" rather than
  guessing. If you added it before, its tile on the home screen says UPDATE:
  click it for the new notes. Your colours, banned phrases and other extras
  on the card are kept, and UNDO puts the old one back.
- Macros can take text. {{SYSTEM:}} Foo bar baz quux -- or
  {{SYSTEM: Foo bar baz quux}} -- sends the model an out-of-character
  directive followed by "Foo bar baz quux"; SYSTEM comes ready-made and can
  be edited. In your own macros, {{input}} marks where passed text goes, and
  {{input1}}, {{input2}}... take pieces split at "|". With no placeholder,
  the text goes on the line after the macro. The editor previews it. Old
  macros work as before; the chat shows what you typed.
- The password minimum is a setting: 8 characters by default for new
  passwords, min_password_length in config.toml takes it as low as 4 (a PIN)
  or higher. A password you already have keeps working.

FIXED
- The RAG Storybook. Lore written either way now fires:
    # Selah, [.7 wing, .3 light, 1.0 angel]      (labelled)
    Selah is an angel wandering the world...      (plain text)
  A labelled entry fires on its name, or when its tags add up to 1.0
  (.7 wing + .3 light). Plain text is split into entries of up to four
  sentences, each firing on a name in it or one of its distinctive words --
  with or without the embedding model. "Plain text fires on" under the
  field asks for 2 or 3 words instead, per character. "wing" matches
  "wings". The header
  line and its weights never reach the model. Older storybook syntax works
  as before. docs/RAG_INFO.md has the details.
- Saving a character ended with an error in the browser console (since the
  UNDO change). Nothing was lost; it no longer happens.
- Deleting or purging several chats and then closing or reloading the page
  within a few seconds brought all but one back from the server (1.7.8
  too). All the deletions now go out together as the page closes.
- Tekken models (Mistral Nemo and its family) answered as if every message
  were about the video game. A built-in chat template now always goes out
  with --no-jinja, and Tekken models are recognised by their tokenizer, not
  only their names.
- Escaping (PR #4): a character or persona name could run script from a
  message header, and thread and folder ids reached drag handlers
  unescaped. Fixed at every sink found, with a lint test.
- Synced and imported code (PR #5): if the check that switches imported
  code off is ever missing, a restore now refuses instead of going ahead.
- Windows (PR #15): closing the setup window also ends the embedding server
  it started. "Setup or add a model" runs gobbonet.exe launch --setup.
- LAN (PR #7): setup-lan.bat opens GobboNet on Private and Domain networks
  only, and on a Public one asks [P] make it Private, [A] allow Public too,
  or [S] skip; setup-lan.bat /public allows Public without asking. The URL
  reservation belongs to your account, not Everyone. Re-run setup-lan.bat as
  Administrator once to apply this.
- gobbonet uninstall left your conversations behind when they were in a
  folder you chose (the Linux setup always asks), and said they were gone
  (1.7.8 too). It now reads your config and clears that folder. The Windows
  uninstaller runs the same command.
- A profile with no conversations showed "syncing..." forever.
- A split model showed every part in the model menu; a broken link in the
  models folder was listed as a model.
- Notes in the page that described older versions: the Personality hint,
  the web search key's note, and Privacy Status.

CHANGED
- File layout: the retired installer/ design is gone; the model catalogue is
  in catalog/, build scripts in scripts/, old investigations in
  docs/archive/. Windows files you run (launch.bat and the rest) stay where
  they were.
- fileserver.ps1, the legacy PowerShell server, says it is deprecated when it
  runs. It goes in 1.8, and only runs without gobbonet.exe.
- Privacy: besides web search (when on) and downloads you start, GobboNet
  fetches two small public lists: the model list, when Add a Model or setup
  needs it (model_catalog_remote = false stops it), and the endorsed mod
  list, only when you click BROWSE. Neither carries anything about you. No
  telemetry.

WINDOWS UPDATE
Close GobboNet. Back up your installation and data. Extract this complete
update over the existing GobboNet application folder. Keep your configuration,
engine, models and history. Then run "Repair Windows shortcuts.bat" once:
it points "Setup or add a model" at the new command. Run setup-lan.bat as
Administrator once if you use GobboNet from your phone. Use Launch GobboNet
from the Start menu as before.

LINUX UPDATE
Close GobboNet. Replace the linux-amd64 folder with the one from this zip;
keep your configuration, models and data. The full zip carries the
llama.cpp engine (linux-amd64/llama-cpp, unchanged since 1.7.8); the
-update zip leaves it out (see NO-ENGINE-IN-THIS-ZIP.txt).

FOR THE GIT REPOSITORY
Extracting a zip cannot move or delete files. Run git-apply-1.7.9-layout.sh
(handed over beside this zip) once in a 1.7.8 checkout BEFORE extracting,
then extract, then git add -A.

CHECKING IT
With the chat page open and signed in, paste these into the browser console
(F12 -> Console). None of them changes your data; the ones that make
throwaway chats, characters or mods remove them at the end.
  tests/console/1.7.9-steps-1-3.js   (load a Tekken model for its checks)
  tests/console/1.7.9-steps-4-6.js   (step 6 is listed as a by-hand check)
  tests/console/1.7.9-step-7.js      (layout and password setting)
  tests/console/1.7.9-step-8.js      (LAN; run it on the phone too)
  tests/console/1.7.9-step-9.js      (UNDO; about 15 seconds)
  tests/console/1.7.9-step-10.js     (CONFIG sections and search)
  tests/console/1.7.9-step-11.js     (the tour; puts "seen" back after)
  tests/console/1.7.9-step-12.js     (catalogue and found models; links nothing)
  tests/console/1.7.9-step-13.js     (mods; run it on the PC; removes what it makes)
  tests/console/1.7.9-step-14.js     (endorsed mods; installs nothing; one red
                                      "deliberate" error is expected)
  tests/console/1.7.9-step-15.js     (the Informant; run it on the home screen;
                                      does not touch your own Informant)
  tests/console/1.7.9-step-16.js     (page, server and ABOUT all say 1.7.9)
  tests/console/1.7.9-rag-storybook.js  (both ways of writing lore fire;
                                      changes nothing)
  tests/console/1.7.9-macro-input.js    (macros that take text; changes nothing)

VALIDATION (run on Linux x64, Go 1.25.14, engine b10456, PowerShell 7.4)
- Go: all 24 packages pass; go vet clean for linux and windows; the
  Windows-only tests compile.
- JavaScript: 60 of 60 suites. Python: 34 of 34, including the PowerShell
  half of test-stop-script.py and test-linux-onboarding.py run from the
  extracted zip with the engine in place.
- Console blocks on this build: steps 1-3 7/7, steps 4-6 14/14, step 7 3/3,
  step 8 (by-hand checklist; the page reports LAN state), step 9 38/38,
  step 10 15/15, step 11 22/22, step 12 15/15, step 13 15/15,
  step 14 14/14, step 15 13/13, step 16 4/4, RAG storybook 13/13, macro input 10/10.
- The full zip, extracted to an empty folder with no config, ran its
  first-run setup and served the chat with the bundled engine.
- The Windows installer, GobboNetSetup-1_7_9.exe (NSIS 3.12, large strings):
  its 61 files are byte-for-byte the zip's, and its file list is the
  official 1.7.8 installer's plus the three new page files. Decompressed
  and compared with 1.7.8's script compiled the same way, it differs only in
  the version, the 8-character password minimum, the "Setup or add a model"
  shortcut and the three new page files. The uninstaller is unchanged.
- Built with Go 1.25.14, the Go 1.7.8 was built with (the first 1.7.9 test
  builds had 1.25.0). scripts/go-floor.sh now refuses an older one.
- The .rpm, built by rpm 4.19.1 as 1.7.8's was, against the official 1.7.8
  package: same requirements, scriptlets and 79 files; five files changed,
  each by a 1.7.9 change. dnf install, first run, a chat, removal and the
  upgrade from 1.7.8 on Fedora 43, 44, 45 and Rawhide roots; on 44 and 45
  also as a user in a browser, the 1.7.8 conversation kept across the upgrade.
- The .deb, built from this zip with the pinned Vulkan engine, against
  the official 1.7.8 package: same control fields, maintainer scripts and 88
  entries; five files changed, each by a 1.7.9 change. Installed with apt on
  Ubuntu 24.04 and used as an ordinary user: the setup page walked with
  Enter, a chat with the bundled engine, an upgrade from 1.7.8 keeping its
  conversation, remove and purge keeping your data, gobbonet uninstall
  clearing it.
- The AppImage, built reproducibly from the .deb with the pinned, signature-
  checked runtime, against the official 1.7.8 AppImage: same runtime and 92
  entries; six files changed, each by a 1.7.9 change. Run as a user through
  FUSE: a fresh first run and a chat; the upgrade from the 1.7.8 AppImage
  keeping its conversation; switching to and from the .deb; gobbonet
  uninstall clearing your data and naming the file to delete.
- In Chromium against the real server: found models linked and generating;
  the old extensions migrating to a mod; endorsed mods installed from a local
  HTTPS copy of the site, a tampered file refused, a broken mod switching
  itself off; the Informant's UPDATE and UNDO; a storybook typed into the
  card editor firing on a name, on tags adding up to 1.0, and on plain
  text's names and words, with nothing for an unrelated line.

NOT RUN HERE
Anything in a Windows console: setup-lan.bat and teardown-lan.bat as
Administrator, the job object closing the tree, the "Setup or add a model"
shortcut, launch.bat, the installer itself (it is also unsigned, as
before, so SmartScreen will ask). A real Tekken model generating
text. The Informant answering on a real chat model. The real embedding
model (Nomic): matching by meaning is unchanged and was tested with a
stand-in. A GPU. On Fedora: SELinux and a real desktop session (the packages
were tested in chroots of the official Fedora roots).
