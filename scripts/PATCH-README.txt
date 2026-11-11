GobboNet 1.8.0

Everything below is in this release. Details for each change are in
docs/changelog/CHANGELOG-1.8.0-*.md.

NEW
- Group chats. + GROUP in the sidebar starts a chat with several
  characters. A group is made in // CHARS under GROUPS, like a character:
  its members, their turn order, and a place in it for you or not. Who
  speaks next: in turn, whoever you name (natural, with a talkativeness
  slider per member), shuffled, by hand, or a DM -- a short extra request
  that asks the model who is best to respond. The bar above the message box
  shows whose turn it is; click a member to have them reply, mute one,
  press NEXT (or Enter on an empty box) for the next, or AUTO to let them
  carry on by themselves. A group can carry a scene, choose how much the
  members know about each other and what a new chat opens with. One model
  plays everyone, one reply at a time, so a round of four is four replies.
- The Files panel. The new button in the top bar opens a panel beside the
  chat with every file in the conversation: what characters write as
  files, text files you attach, and web pages or pictures written as code.
  Writing the same file again makes a new version, with arrows to step
  through them. Markdown and CSV show rendered; a web page previews in a
  frame that cannot reach the internet or GobboNet, with its scripts off
  until RUN SCRIPTS. EDIT a file, then USE IN MY NEXT MESSAGE hands your
  version back; ASK ABOUT THE SELECTION asks about part of it.
- Auto Reroll. Give a character Off-limits words, and a reply that uses
  one is stopped and written again, up to the number of tries you choose.
  It reads the reply, never the thinking. Banned Phrases and Auto Reroll
  work best together.
- The update button. ABOUT > CHECK FOR UPDATES asks GitHub for a newer
  GobboNet, only when you press it. UPDATE NOW asks, downloads the release,
  checks the maintainer's signature and the checksums, runs the new program
  once to be sure it starts, and puts it in place; RESTART NOW starts it.
  It never installs an older version; a later build of the same version
  (a hotfix) is offered. Only the program file is replaced: chats, models,
  settings and your password stay. A .deb or .rpm is updated with the new
  package, so for those the button links the release page. docs/UPDATES.md
  has the details, and update_releases_url = "" in config.toml switches it
  off.
- Model links (issue #52). A chat remembers the model that wrote it, and a
  character can name the model it was made for (Model for this character,
  in the character editor). Opening the chat, or starting one with that
  character, offers to switch. CONFIG > Characters & Chat > Model Switching
  can make it switch on its own, or never. A group chat keeps to the model
  it last used.
- Tools from a character's code (issue #70, PR #71). A character's custom
  code can offer the model functions to call, with gobbo.tool(...). The
  model calls them only while "Let the model call this card's tools" is
  ticked on that card; imported cards arrive with it off. CONFIG >
  Characters & Chat > Card Tools sets the limits per reply.
- MCP servers (issue #42). CONFIG > Advanced > MCP Servers sets up MCP
  servers, small programs on this PC that offer tools: + ADD SERVER, or
  PASTE A SETUP (JSON) from the block most servers document. CHECK TOOLS
  starts one and lists what it offers. Servers are added and switched on
  only on the PC; any signed-in device can switch one off. This release
  sets them up and checks them; characters calling their tools in a chat
  comes later.
- The GPU menu (issue #72). CONFIG > Model & Performance > Performance >
  GPU chooses the graphics card the engine uses, from the list the engine
  itself sees. On Linux, a laptop whose engine sees only the integrated GPU
  is offered the NVIDIA one through PRIME offload. gobbonet doctor says
  which card and which engine build are in use, and why.
- Why a model failed to load (issue #67). The chat, the home screen and
  gobbonet doctor say why in plain words -- not enough memory, an
  incomplete or damaged download, a model this engine cannot read, a
  missing file -- with what to try, instead of "EXITING DUE TO MODEL
  LOADING ERROR" and a 503. CHECK FILE in Add a Model tests a download
  against its checksum.
- Every model in the catalogue has a pinned checksum, so none is marked
  Unverified.
- Setup asks for a data folder and a models folder (issue #68, Linux). A
  folder that already holds GGUF models says how many, and the models
  folder can be the one your models are already in. CONFIG > Model &
  Performance > Model Folders changes it later, on the PC. Uninstalling
  never empties a models folder you chose: asked to delete models, it takes
  only the .gguf files directly in it.
- open_browser (PR #58). CONFIG > Basics > When GobboNet Starts, or
  open_browser = false in config.toml, starts GobboNet without opening a
  new browser tab.
- The embedding server (PR #56). GobboNet starts the small second engine
  that lets the RAG Storybook and memory files match by meaning, and
  restarts it if it stops. CONFIG > Privacy Status says whether matching by
  meaning is on, and why not.
- My extensions has a switch for each stylesheet and script in it (from
  Larck Drakengold's commit 4db2469), so one that misbehaves can be turned
  off without the rest.
- The Gobbonet Informant knows 1.8.0. If you added it before, its tile on
  the home screen says UPDATE.

FIXED
- Macro names typed with braces (issue #69, PR #73). {{skip}} or skip: in
  Trigger name saves as skip, and the note under the field says so.
- A model name is a file in the models folder and nothing else (security).
  Switching models used to accept a path, so any signed-in device could
  make the engine load a file from anywhere. Only a plain .gguf name is
  accepted now.
- gobbonet uninstall left the folder the update button downloads into, so
  the data folder stayed behind after an uninstall. It removes it now, and
  the Linux launcher's engine-choice note with it. On Linux it also left
  behind the embedding model that setup downloads (in the data folder's
  embeddings folder); that goes now too, even when you keep your models,
  and anything else in that folder stays. The Windows uninstaller runs the
  same command, and also removes what an update leaves beside the program
  (gobbonet.exe.old and an unfinished gobbonet.new.exe).
- On Linux, a first run stopped before setup finished left a setup.XXXXXX
  file in ~/.local/share/gobbonet, which kept that folder after gobbonet
  uninstall, and could leave the setup page running. The launcher now stops
  the page and removes the file however the first run ends, and gobbonet
  uninstall removes the ones older versions left.
- The AppImage's Start at login named the launcher inside the AppImage's
  temporary mount, so it did nothing at the next login. It starts the
  AppImage file itself now; if you move the file, run its
  autostart --enable again.

CHANGED
- The legacy PowerShell server, fileserver.ps1, is gone. launch.bat asks
  the first-run questions and hands over to gobbonet.exe; without
  gobbonet.exe it stops at the start and says how to get it back.
  setup-lan.bat makes no URL reservation (gobbonet.exe never needed one)
  and removes the ones older versions left.
- Classifier-free guidance (issue #51) was checked against this release's
  engine: it still cannot be done, so Banned Phrases and Auto Reroll remain
  the way to keep words out.
- Privacy: besides web search (when on) and downloads you start, GobboNet
  goes online for the model list and the endorsed mod list, as before, and
  for update checks, only when you press CHECK FOR UPDATES. None of them
  carries anything about you. No telemetry.
- The Windows installer's header says v1.8.
- For contributors: issue forms and a pull request template (issue #62),
  and every documented build command works without the executable bit.

WINDOWS UPDATE
With the installer: close GobboNet and run GobboNetSetup-1_8_0.exe. It
installs over your current copy, keeps your models, conversations and
password, and deletes the old fileserver.ps1.
With the zip: close GobboNet, extract this complete update over the
GobboNet folder, and keep your configuration, engine, models and history.
A zip cannot delete files, so fileserver.ps1 and fileserver.log stay in
the folder; nothing runs them now, and you can delete them (gobbonet
doctor lists them under LEFTOVERS FROM 1.7).
If you use GobboNet from your phone, run setup-lan.bat as Administrator
once: it removes the URL reservation older versions made. From 1.8.0 on,
ABOUT > CHECK FOR UPDATES does the update for you.

LINUX UPDATE
With the .deb or the .rpm: close GobboNet and install the new package over
the old one, sudo apt install ./gobbonet_1.8.0*_amd64.deb or
sudo dnf install ./gobbonet-1.8.0-*.fedora.x86_64.rpm, from the folder you
downloaded it to. Your settings, models and conversations are not part of the
package, and stay.
With the zip: close GobboNet, replace the linux-amd64 folder with the one
from this zip, and keep your configuration, models and data. The full zip
carries the llama.cpp engine (linux-amd64/llama-cpp, unchanged since
1.7.8); the -update zip leaves it out (see NO-ENGINE-IN-THIS-ZIP.txt). From
1.8.0 on, ABOUT > CHECK FOR UPDATES updates the zip and the AppImage.

FOR THE GIT REPOSITORY
Extracting a zip cannot delete files. In a 1.7.9 checkout, run
  git rm fileserver.ps1
then extract this zip over it, then git add -A.

CHECKING IT
With the chat page open and signed in, paste these into the browser console
(F12 -> Console). None of them changes your data unless it says so at the
top; the ones that make throwaway chats or characters remove them.
  tests/console/1.8.0-round-1.js     (macro names with braces)
  tests/console/1.8.0-round-2.js     (the model name check)
  tests/console/1.8.0-round-3.js     (open_browser, and the two folders)
  tests/console/1.8.0-round-4.js     (card tools, model links)
  tests/console/1.8.0-round-5.js     (why a model failed to load, CHECK FILE,
                                      the GPU menu)
  tests/console/1.8.0-round-6.js     (the legacy server is gone)
  tests/console/1.8.0-round-7.js     (entry switches in My extensions)
  tests/console/1.8.0-round-8.js     (the embedding server)
  tests/console/1.8.0-round-9.js     (MCP servers; run it on the PC)
  tests/console/1.8.0-auto-reroll.js
  tests/console/1.8.0-files-panel.js
  tests/console/1.8.0-update-button.js
  tests/console/1.8.0-group-chats.js
  tests/console/1.8.0-version.js     (page, server and ABOUT say 1.8.0, the
                                      Informant, and with GN_UPDATE_CHECK
                                      the update key; asks GitHub only then)

VALIDATION (run on Linux x64, Go 1.25.14, engine b10456)
- Go: the 25 packages with tests pass; internal/version's check against the
  release tag passes once v1.8.0 is tagged (docs/BUILDING.md). go vet clean
  for linux and windows; the Windows test binaries compile; the race detector
  on cmd/gobbonet and internal/update.
- JavaScript: 73 of 73 suites. Python: 40 of 40.
- Each feature's console check and live browser checks ran when it was built
  (each changelog has them): group chats 43 live checks in Chromium against a
  stand-in engine, the Files panel's preview isolation in Chromium, the
  update button installing and restarting into a signed build from a local
  release list, a tampered build refused.
- The update signing key: its public half is built in, and a file it signs
  verifies while a changed one does not.
- The Windows installer, GobboNetSetup-1_8_0.exe (NSIS 3.12, large strings,
  built from the v312 source with MinGW-w64 GCC):
  - The same toolchain rebuilds the official GobboNetSetup-1_7_9.exe from
    the v1.7.9 script and its own payload byte for byte, and 1.8.0's stub and
    plugins are 1.7.9's very files.
  - Its 66 files are byte-for-byte this zip's. Its file list is 1.7.9's
    without fileserver.ps1, plus the six new page files.
  - Decompressed and compared with the official 1.7.9, it differs only in the
    version (title, DisplayVersion, version resource), fileserver.ps1 being
    deleted instead of installed, and the six files. The uninstaller differs
    only in removing what the update button leaves.
  - Under Wine 9.0, page by page beside 1.7.9: only the version marks and the
    install's size differ. A fresh install, an upgrade over 1.7.9 (models,
    engine and password kept) and an uninstall after an update, which left
    nothing behind.
- The Linux .deb, gobbonet_1.8.0+go.<commit>-1_amd64.deb, built from this
  zip with the pinned engine:
  - The same way of building rebuilds the official 1.7.9 .deb byte for byte
    from its sources and program.
  - Against the official 1.7.9: the same 88 entries, modes, owners and
    links; 81 byte-identical, the engine among them; the other 7 are this
    zip's files and ENGINE.txt's "bundled by" line. The same scripts and
    dependencies, and lintian finds the same.
  - Installed with apt on Ubuntu 24.04 and used as ordinary users: an
    upgrade over 1.7.9 (conversation, password, config and model kept);
    first runs whose pages match 1.7.9's but for the location page and the
    model page's note; chats answered by the bundled engine; a first run
    stopped part way; tests/test-linux-onboarding.py; apt remove and purge,
    which left the home folders untouched; and gobbonet uninstall, which
    left nothing of GobboNet's.
- The Fedora .rpm, gobbonet-1.8.0-1.go.<commit>.fedora.x86_64.rpm, built
  from this zip with the pinned engine and rpm 4.19.1, as 1.7.9's was:
  - The same toolchain rebuilds the official 1.7.9 .rpm with every header
    field and file the same but the build time and the file times the
    build sets (1.7.9 was built without SOURCE_DATE_EPOCH).
  - Against the official 1.7.9: the same 72 requirements, recommends,
    scriptlets and 79 files, folders and links; 72 files byte-identical,
    the engine among them; the other 7 are this zip's files, ENGINE.txt's
    "bundled by" line and FEDORA.md. check-rpm.sh passes, and rpmlint
    finds the same in both.
  - test-in-fedora.sh on Fedora 43, 44, 45 and Rawhide, upgrading from the
    official 1.7.9: 20/20, 20/20, 21/21, 21/21.
  - On Fedora 44 and 45, as ordinary users in a browser, 35 checks like
    the .deb's, all passing: an upgrade from 1.7.9 keeping the
    conversation, password, config and model; first runs; chats; a first
    run stopped part way; dnf remove; gobbonet uninstall.
- The AppImage, GobboNet-1.8.0go.<commit>-1-x86_64.AppImage, made from
  that .deb with the pinned type 2 runtime:
  - The same way rebuilds the official 1.7.9 AppImage byte for byte from
    its .deb.
  - Against the official 1.7.9: the same runtime and the same 92 entries,
    modes and links. What differs is six of this zip's files and two
    version lines, in the menu entry and the engine's ENGINE.txt. Every
    file under usr/ is the .deb's.
  - Run by ordinary users through FUSE, 33 checks: from the 1.7.9
    AppImage to this one (conversation, password and model kept, the
    engine path healed); first runs; chats; Start at login, which now
    starts the AppImage after it has closed; a first run stopped part
    way; tests/test-linux-onboarding.py through it; gobbonet uninstall;
    without FUSE, --appimage-extract-and-run.
  - The update button replacing it: a test build offered a later one by
    a stand-in release list, signed with a throwaway key. UPDATE NOW put
    the new AppImage in place of the old file, RESTART NOW came back on
    it, and Start at login still started it. 15 checks.
  - In Fedora 44 and 45 root filesystems, without FUSE: on 44 its engine
    starts with the system's libraries; on 45 it starts once OpenSSL 3 is
    there (Fedora 44's libraries standing in for openssl3-libs), and not
    without it.

NOT RUN HERE
Windows itself: the installer ran under Wine, which draws the pages without
the Windows visual style and has no PowerShell (so the password store and
part of stop-gobbonet.bat did not run there), SmartScreen or Defender. The
installer is unsigned, as before, so SmartScreen will ask. Launch GobboNet
from the finish page and the shortcuts were read, not started. A GPU. A real
chat model answering in a group chat or through card tools. On Linux: a
desktop (the .deb, .rpm and AppImage were installed and run in a container
and in Fedora root filesystems, with the browser driven headless), and
SELinux.
