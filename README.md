# GobboNet — Your Own Private AI Front End, Now With An Easily Downloaded .exe

GobboNet lets you run an AI chatbot **on your own computer**, with no accounts, no monthly fees, and nothing sent to the internet. The AI lives on your machine. When you talk to it, your words never leave your home.

This guide assumes you've never set up anything like this before. Take it one step at a time and you'll be chatting in about 20–30 minutes (most of that is just waiting for files to download).

---

## Working models

- **Llama** — working
- **Gemma** — working
- **DeepSeek** — working
- **Qwen** — working [Qwen3 30B-A3B, QwQ 32B]
- **gpt-oss** — working [20B and 120B, Harmony format]
- **Mistral** — working [Mistral Small 24B and its finetunes, including Cydonia and Magidonia; from 1.7.9 also Tekken-format models such as Mistral Nemo]
- **Granite** — working
- **Command R** — working
- **GLM** — working

---

## What you're actually setting up

- There's a **launcher** (`launch.bat`, behind the GobboNet shortcut) that starts everything for you.
- There's the **AI engine** — the program that does the actual thinking. It's about 300 MB and downloads once.
- There's the **AI model** — this is the "brain." It's a big file (usually 4–16 GB). You pick one from a menu and it downloads once.
- There's a second, much smaller **retrieval model** (~146 MB) that also downloads once. It's what lets a character pull the relevant parts of its own notes and lore into a conversation instead of re-reading all of it every turn.
- There's the **chat screen** itself, which opens in your web browser like a normal website — except it's running entirely on your own computer.

You download the engine and a model **one time**. After that, everything runs offline, forever.

---

## What you need before you start

- **A Windows 10 or Windows 11 PC, or a 64-bit Linux PC.** This guide walks through Windows. On Linux there's a `.deb`, an `.rpm`, an AppImage and the ZIP; follow [LINUX-START-HERE.md](LINUX-START-HERE.md) instead. Mac isn't supported.
- **A graphics card (GPU) helps a lot.** The AI runs *much* faster on a graphics card. It will still run without a good one, just slowly. The setup checks your hardware and recommends a model that fits.
- **Free hard-drive space.** At least 10–20 GB free, ideally more. The AI models are large.
- **An internet connection for the first setup only.** After the one-time downloads, you can unplug from the internet and it still works.

You do **not** need to be technical, create any account, enter a credit card, or install anything complicated. Just downloading and running the exe from the released versions will do all of this for you.

---

## Step 1 — Install it

Go to the [Releases page](https://github.com/ElodineOfficial/gobbonet/releases) and download **`GobboNetSetup.exe`**. It installs just for you, and it doesn't need admin rights.

Double-click it. Windows will probably say **"Windows protected your PC"** — click **More info**, then **Run anyway**. That warning appears because the installer isn't signed with a paid certificate, not because anything is wrong with it. Firefox may also hold the download back as one that isn't commonly downloaded; allow it from the downloads list. Same reason.

When it finishes you'll have GobboNet in your Start Menu and on your desktop, along with an uninstaller that asks before it goes anywhere near your downloaded models.

That's the whole install. Skip ahead to Step 2.

---

## Alternative Download Method: Step 1 — Get the files

If you'd rather not run an installer, click the green **Code** button at the top of the repo, choose **Download ZIP**, and extract it somewhere easy to find, like `Documents\Gobbonet`.

**Keep the folder exactly as it comes out of the ZIP.** GobboNet isn't a handful of loose files anymore — `chat.html` loads its styling from the `css\` folder and its code from the `js\` folder. If those get flattened together or left behind, the chat screen opens as a blank, broken page. Don't pull files out of the repo one at a time either; grab the whole ZIP.

You should end up with this:

```
Gobbonet\
├── launch.bat            <- start here
├── gobbonet.exe          <- the server launch.bat hands over to
├── setup-lan.bat         <- phone access, run as Administrator once
├── stop-gobbonet.bat
├── teardown-lan.bat
├── hardware-probe.ps1
├── hw-recommend.ps1
├── identify-model.ps1
├── engine.sha256         <- which llama.cpp build, and its checksum
├── chat.html             <- source of the chat screen (built into the .exe)
├── default-characters.json
├── gobbonet.ico
├── manifest.webmanifest  <- the phone home-screen icon's name and colours (built in too)
├── icons\   (3 files)    <- the home-screen icons, source as above
├── css\     (17 files)   <- source, as above
├── js\      (24 files)   <- source, as above
├── linux-amd64\          <- the Linux build; Windows users can ignore it
├── docs\    reference notes and the per-change changelog
└── tests\   developer tests; not needed to run anything
```

A `models` folder and a few small bookkeeping files get created for you on the first run — that's normal, you don't need to make them yourself. Updating from 1.7 by extracting the ZIP over your folder can leave a `fileserver.ps1` behind; nothing uses it any more, and you can delete it.

Going this route, run **`launch.bat`** wherever the rest of this guide says the
**GobboNet** shortcut, and right-click `setup-lan.bat` → **Run as
administrator** where it says **LAN Setup**. Everything else works the same.

`launch.bat` is the black-and-green window that walks you through everything —
setting a password, downloading the AI engine, checking your hardware, picking a
model. When it has your answers it hands over to `gobbonet.exe`, which serves the
chat and keeps running in that same window, so the model loading and the GPU
check appear right where you have been reading. You do not need to start
`gobbonet.exe` yourself.

One cosmetic difference: the installer bundles a font that the source ZIP does not, so a browser console opened on a source install will show a 404 for `fonts/atkinson-hyperlegible.woff2`. Nothing is broken — the interface falls back to a monospace font your system already has. The font is left out on purpose rather than committed, so that GobboNet never fetches one from a font CDN at runtime.

---

## Step 2 — Run the launcher

Double-click the **GobboNet** shortcut on your desktop, or **`launch.bat`** in the install folder.

A black window with green text will open. This is normal — it's the launcher talking to you. **Read what it says**, because it asks you a few simple questions the first time.

### It will ask you to set a password

The very first time, it asks you to **choose a password**. Type one (at least 8 characters by default; `min_password_length` in `config.toml` changes that) and press Enter, then type it again to confirm.

This password protects your chat. Anyone else on your home Wi-Fi could otherwise open it, so the password keeps it private. You'll only type it again when you connect from your phone.

> Your password is stored in a scrambled form that can't be reversed, and it is never written down anywhere in readable form. If you forget it, you can set a new one (see Troubleshooting).
>
> When you sign in **from your phone**, the password itself travels across your home network unencrypted, the same as everything else here. The sign-in page says so too. That is fine on a network you trust — but it is why you should not reuse a password that matters elsewhere, and why you should not run this on shared or public Wi-Fi.

### It will offer to download the AI engine

Next it says the engine isn't installed yet and asks **"Download llama.cpp now?"** Type **Y** and press Enter. This is the ~300 MB one-time download. Wait for it to finish.

### It will help you pick a model (the AI "brain")

If you don't have a model yet, it checks your computer's hardware and shows a menu like this:

```
Detected: 16 GB VRAM, 32 GB RAM, 423 GB free disk

  -- SMALL (fits ~6 GB VRAM) ----------------------

    [2] Llama 3.2 3B Instruct  Q8_0    ~3.4 GB
    [1] Gemma 4 E4B IT         Q4_K_M  ~5.4 GB

  -- MEDIUM (fits ~8-12 GB VRAM) ------------------

    [4] Qwen3.5 9B             Q4_K_M  ~6.2 GB
    ...
    [8] gpt-oss 20B            MXFP4   ~12 GB   [ RECOMMENDED FOR YOUR PC ]

  -- LARGE (16 GB VRAM and up) --------------------

    [5] Gemma 4 26B-A4B MoE    Q4_K_S  ~16 GB   [ needs ~18 GB VRAM - will be slow ]
    ...

  -- MANUAL ---------------------------------------

   [11] Skip - I'll add my own .gguf
```

One option is marked **`[ RECOMMENDED FOR YOUR PC ]`** — that's the best fit for your hardware. Just press **Enter** to accept it, or type a number to pick a different one. Then wait while it downloads (a big model can take 10–30 minutes — this is the longest part, and it only happens once).

Notice that the 16 GB card above is *not* offered the 16 GB model. A model needs room beyond its own size — for the conversation it is holding in memory, for the engine's working space, and for whatever your monitor is already using. Every recommendation leaves at least 2 GB spare, which is why the biggest thing that fits is rarely the right pick.

Models that want more than you have are labelled with what they actually need, and picking one anyway will ask you to confirm first. When in doubt, take the recommended one.

### It will grab one more small download

Once your model is sorted, the launcher fetches the retrieval model (~146 MB, one time). This is what lets a character pull the relevant pieces of its lorebook into a conversation instead of trying to hold everything at once.

It runs on your processor rather than your graphics card, so it won't take memory away from the model you're actually chatting with. Like everything else here, it never phones home after the download.

### That's it

Once the model loads, your **web browser opens automatically** to the chat screen. You can start typing. (If you keep a tab open, or use GobboNet from your phone, untick **CONFIG > Basics > Open the browser when GobboNet starts**.)

Every time you want to use it in the future, you just open GobboNet again. After the first setup, it starts in well under a minute and **the AI itself never needs the internet**.

Two things reach out, and both are yours to turn on: web search, if you set up a key for it, and any extension you load from a web address rather than pasting in directly. Neither is on unless you switch it on.

---

## Step 3 (optional) — Use it from your phone

You can chat from your phone or tablet **as long as it's on the same Wi-Fi** as your PC. This is optional — skip it if you only want to use it on the PC.

1. Open **GobboNet LAN Setup** from your Start Menu (or right-click `setup-lan.bat` in the install folder → **Run as administrator**). It tells you exactly what it's about to change before Windows asks for admin permission — say yes to the prompt. This opens the door for your phone to connect. You only ever do this **once**.
2. Look at the launcher window. Under **phone / LAN** it prints the addresses to try, with the name of the network adapter each one belongs to:

   ```
   phone / LAN:   http://192.168.1.24:9066/    (Ethernet)
                  http://10.0.0.57:9066/       (Wi-Fi)
   ```

3. On your phone's browser, type the top one — all of it, `http://` included. Without it, Safari tries `https://` and fails. Enter the password you chose. Done.

**Put it on your home screen.** Once it loads, add it like an app: on iPhone or iPad, Safari's **Share** button → **Add to Home Screen**; on Android, Chrome's **⋮** menu → **Add to Home screen**. The icon keeps the whole address, `http://` included, so you never type it again. On iPhone and iPad it opens full screen, without Safari's bars, and keeps its own sign-in apart from Safari's: sign in once more the first time, and your chats come over from the PC by themselves. On Android it opens in Chrome as usual.

> **If there's more than one address, that's normal** — it means your PC has more than one network adapter, and only your phone knows which one it shares. Work down the list. The line whose adapter name matches the Wi-Fi your phone is on is the one that will work. Anything marked *virtual adapter* or *VPN or tunnel* is listed for completeness and is almost never the answer.

The **LAN Setup** window also prints a `http://your-pc-name.local:9066` address at the end of its run. That one is worth bookmarking where it works, because it survives your PC's network address changing and so keeps your saved chats attached to the same address. It relies on a feature called mDNS, which iPhones and iPads handle well and some Android browsers do not — if it doesn't load, use a number address from the list above instead. Nothing is wrong; that's just Android.

---

## Using the chat

Gobbonet is more than a plain chatbox. Here are the parts you'll actually use, in plain terms:

- **Just type and chat.** Type in the box at the bottom, press Enter. That's the basics.
- **Characters.** It comes with a few built-in personalities (a terse coder, a wordy lore-keeper, a riddle-speaking oracle). You can switch between them or make your own — give it a name, a description, and a style, and the AI will play that role. You can also **bring in character cards you already have, and send yours back out** (the common `.png` cards used by other AI chat apps), so your existing collection works here too. Most cards carry over cleanly, though a few may need small tweaks after importing.
- **lorebooks.** A character can carry a lorebook — lore, world details, backstory, notes, whatever you want it to know. Rather than cramming all of that into every single message, GobboNet works out which bits are actually relevant to what you're talking about right now and quietly slips those in. It means a character can "know" far more than would ever fit in one conversation.
- **Threads.** Each conversation is saved separately in the sidebar, like chat history. You can rename them, pin favorites, and sort them into folders.
- **Web search (optional).** There's a search button that lets the AI look things up online. It needs a free key — see below. Off unless you turn it on.
- **Adding models (optional).** Config → **Add a Model** shows a catalogue you can download from without leaving GobboNet or working out HuggingFace's interface. GobboNet downloads the file, checks it, and puts it where it belongs. The list itself is a small public file fetched from goblincorps.com so it can be kept current — a plain download with nothing about you or your machine attached, cached for a day, and switchable off with `model_catalog_remote = false`. If it can't be reached, the list that shipped with GobboNet is used instead and downloading still works.
- **Switching models.** If you've downloaded more than one model, you can switch between them from a dropdown at the top — no need to restart.
- **Using a server you already run (optional).** If you already have llama.cpp or Ollama running, GobboNet can talk to that instead of starting its own engine. Open `config.toml` (on the PC running GobboNet, Config → Advanced → **Config File** opens it for you), set `server_exe = ""` and point `llm_url` at your server:

  ```toml
  server_exe = ""
  llm_url    = "http://127.0.0.1:11434"   # Ollama's default; llama.cpp is usually 8080
  ```

  The model dropdown then lists whatever **your** server reports, and picking one just changes which model the next message goes to — there's no restart, because GobboNet isn't the one running it. Everything else works exactly the same: characters, lorebooks, threads, RAG, web search. Any `.gguf` files you also have in `models` still show up in the same dropdown alongside them.
- **Saving files.** If you ask the AI to write something like code or a document, it can give you a **Save** button to download it.
- **Settings.** A gear/settings area lets you tweak things, change the look, and manage your data.

### Turning on web search (optional)

The search button needs a free key from Ollama:

1. Go to **ollama.com**, make a free account, and get an **API key**.
2. In Gobbonet, open **Settings** and paste the key into the API-key box.
3. Now the search button works. (Searches go through Ollama; everything else stays on your machine.)

If you never set this up, the chat still works perfectly — you just won't have the live-search button.

---

## Keeping it private and safe

This tool was built to be private, but a few honest notes:

- **The AI itself is 100% offline.** Your conversations are not sent anywhere. There are no accounts and no tracking.
- **The password keeps other people out.** Anyone on your Wi-Fi could otherwise reach the chat, so don't disable it.
- **The connection is not encrypted.** This is fine on a home network you trust. **Don't run this on public or shared Wi-Fi** (like a coffee shop), and don't reuse an important password here.
- **Your chats are saved in your browser.** If you clear your browser data, or switch browsers, your history may not carry over (though the app tries to back it up and offer to restore it).

---

## Updating to a newer version

**Press CHECK FOR UPDATES (1.8.0 and later).** Open the **≡** menu, choose
**ABOUT**, and press **CHECK FOR UPDATES** under the version. If a newer
GobboNet is out, **UPDATE NOW** asks first, then downloads it, checks that it
really comes from GobboNet, and replaces `gobbonet.exe` for you. **RESTART
NOW** starts the new version; you sign in again. It never installs a version
older than yours, and nothing is checked until you press the button. Do it on
the PC GobboNet runs on; a phone can only check. More in
[docs/UPDATES.md](docs/UPDATES.md).

**By hand: replace one file, `gobbonet.exe`.** That's the whole update.

Download the new ZIP, open it, and copy `gobbonet.exe` into your GobboNet
folder, replacing the one already there. Your models, conversations, characters
and password are all kept — none of them live in that file.

The chat screen is built *inside* `gobbonet.exe`, so you cannot end up with a
new chat screen and an old program, or the other way round. That used to be the
most common way an update went wrong: people copied `chat.html`, `js\` and
`css\` across, which changed how the app looked while everything that runs
behind the scenes stayed on the old version. Features would appear in the menus
and then do nothing.

**Windows won't let you replace it while it's running.** Close GobboNet first
(see *Shutting it down*, below). If Windows offers to **Skip** the file because
it's in use, don't — that leaves you half-updated. Close GobboNet and copy it
again.

Copying the rest of the folder across as well is harmless. Nothing else is
required, and a leftover `web\` folder from an older version is ignored — the
launcher window says so when it starts, and you can delete it.

**Checking it worked.** Open the **≡** menu, choose **ABOUT**, and look at the
version. If something is out of step, that panel says so and what to do about
it.

**Did you install with `GobboNetSetup.exe`?** CHECK FOR UPDATES works there
too. Or run the new `GobboNetSetup.exe` over it; it replaces the files for
you and keeps your models.

**On Linux?** The button updates the ZIP's `linux-amd64/gobbonet` and the
AppImage. By hand, replace the whole `linux-amd64` folder, or install the new
`.deb`/`.rpm` over the old one, which is also how a package install is updated.

---

## Shutting it down

To stop everything: find the launcher window (the black window with green text — it shrinks to your taskbar after a few seconds) and **close it**, or click it and press **Ctrl + C**.

That window quietly watches the AI in the background and restarts it if it ever hiccups, so it's normal for it to stay open while you're using the chat.

---

## Troubleshooting

**The chat says it can't connect to the AI / it's very slow.**
The model may be running on your processor instead of your graphics card, which is slow. **Look at the GobboNet window:** it says `GPU acceleration confirmed` once the model has loaded, or prints a warning with the likely causes if it could not confirm it. The engine's own loading output appears there too, marked `[llama]`. Make sure your graphics drivers are up to date (search your card maker's site: AMD, Intel, or NVIDIA). If it's still slow, pick a smaller model next time.

**The chat screen is blank, unstyled, or looks broken.**
The `css` and `js` folders aren't where the app expects them. This only happens on a manual install — re-extract the ZIP and keep the folder structure exactly as it comes, or just use the installer.

**My phone can't connect.**
Make sure your phone is on the **same Wi-Fi** as the PC. Then run **LAN Setup** from your Start Menu one time.

If it still won't connect, **try every address under `phone / LAN`, not just the first**. A PC with both an Ethernet cable and Wi-Fi has an address on each, and only the one matching your phone's network will work. The adapter name in brackets after each address tells you which is which.

If none of them work, run this from the install folder and read the **LAN ACCESS** section it prints:

```
gobbonet doctor
```

It says whether the firewall rule exists, whether it's on the right port, and whether something is blocking the app despite the rule.

**The model won't load.**
GobboNet says why in plain words: on the home screen next to OFFLINE, in the chat, and in the console. The usual causes are not enough GPU memory (lower the context size or GPU layers in CONFIG > Model & Performance > Performance, or pick a smaller model), a download that was cut short (CHECK FILE in Add a Model compares the file with its published checksum), or a model newer than the engine. **details** under the message shows the engine's own line, and `gobbonet doctor` prints a **LAST MODEL LOAD** section and where the engine's full log is.

**My graphics card isn't being used.**
Run `gobbonet doctor` and read its **GPU** section: it lists every GPU the engine can see, which one it uses, and, on Linux, whether it fell back to the CPU-only engine and why. CONFIG > Model & Performance > Performance has a **GPU** menu to pick one. On a Linux laptop whose NVIDIA card is missing from the list, a **PRIME offload** switch appears there.

**My saved chats disappeared.**
This usually happens when you opened the chat at a different web address than before (for example, the PC's network number changed). The app keeps a backup and will usually offer to restore it. To avoid this entirely, always use the `.local` address and bookmark it.

**I forgot my password.**
You can set a new one. Delete the hidden file named `.gobbonet-secret` from your GobboNet folder and relaunch — it will ask you to set a fresh password. If you installed the manual way, you can instead open the launcher folder, hold Shift and right-click in empty space, choose the terminal/command option, and run:
```
launch.bat reset-password
```
Either way, restart your computer after this or it will not take properly.

**The download failed.**
Run the launcher again — it will pick up where it left off. If the engine or a model repeatedly fails, your internet may be blocking it; try again on a different connection. The launcher also prints manual download links if you'd rather grab the files yourself.

**A model is too big and crashes or errors during chat.**
It's running out of graphics memory. Use a smaller model from the download menu, or ask whoever set this up to lower `CTX_SIZE` at the top of `launch.bat`.

### Specific errors you might see

Sometimes an error code shows up. Here's what the common ones mean and the quickest fix for each.

**The chat won't load, or you see a `500` error.**
Your model is too big for your graphics card's memory. The "context limit" (how much the AI can read at once) plus the model size is asking for more memory than you have. Use a smaller model, or have someone lower `CTX_SIZE` at the top of `launch.bat`.

**The model won't load, or you see a `502` error.**
A `502` means GobboNet is running but the AI engine behind it is not answering. **Check the front page of the chat first** — where it normally says the model is online, it will now say what actually went wrong, in the engine's own words. That is usually the whole answer.

If it says something about memory, the model is too large for your graphics card; pick a smaller one. If there is no explanation to be had, the most common cause is another AI program called **Ollama** starting up on its own and taking the port GobboNet needs. Close Ollama (check your system tray near the clock, right-click its icon, and quit it), then run the launcher again.

**The web address won't load on my phone.**
The phone address can change when the PC or its network restarts. First, double-check you're typing the **exact** address the launcher window currently shows — it may have changed since last time. Bookmarking the `.local` address (instead of the number address) avoids this.

**Switching models gave me a `404` error.**
The model file is probably in the wrong place. Make sure every `.gguf` file is inside the **`models`** folder, directly — not in a subfolder and not loose in the main folder.

**Switching models gave me a `502` error.**
Open **Task Manager** (press Ctrl + Shift + Esc), find anything labeled **"Windows PowerShell,"** and end those tasks. Then run the launcher again. This clears out a stuck background process.

**I was mid session and everything broke!**
The LAN access for mobile access has changed on the variable address. There is a more stable address listed right above it.

---

## Known bugs
We like to be upfront about what's broken. We'll update this section as we squash them.

Nothing is listed right now. If you find something, open an issue on GitHub: the bug template asks for what we need to track it down.

### Recently fixed

**A model that won't load saying only "EXITING DUE TO MODEL LOADING ERROR"** — *fixed in 1.8.0.* That is llama.cpp's sign-off, not the reason, and the chat then said `llama-server returned 503`. The chat now shows the line that says why (out of memory, a damaged or unfinished download, a model this engine can't read) with what to try, and **CHECK FILE** in Add a Model tests the download against its checksum. Issue #67.

**Setup making an empty models folder** — *fixed in 1.8.0.* Pointing the Linux setup at the folder your models were already in made a new, empty `models` folder inside it. Setup now asks for a data folder and a models folder separately, and says when a folder already holds GGUF models. Issue #68.

**A laptop's NVIDIA card going unused** — *fixed in 1.8.0.* Nothing said which GPU the engine was using or let you choose. CONFIG > Model & Performance > Performance has a **GPU** menu, `gobbonet doctor` says which card and which engine build are in use and why, and on Linux a switch sends the work to the NVIDIA card through PRIME offload. Issue #72.

**RAG Storybook lore not being pulled in** — *fixed in 1.7.9.* A labelled entry like `# Selah, [.7 wing, .3 light, 1.0 angel]` was not read as an entry at all, a name in a header did not trigger anything, and plain-text lore only worked with the optional embedding model running. Now both ways work: a labelled entry fires on its name or when its tags add up to 1.0, and plain text is split into entries of up to four sentences that fire on a name or one of their words (two or three if you set it that way per character) — with or without the embedding model. See `docs/RAG_INFO.md`.

**Tekken models answering about the video game** — *fixed in 1.7.9.* Mistral Nemo and other models that use Mistral's "Tekken" chat format replied as if every message were about the fighting game. The engine was reading the format's built-in name as the conversation itself, because newer llama.cpp builds switch their own template handling on by default. GobboNet now switches it off whenever it hands over a built-in format, and recognises Tekken models by what is inside the file (Magistral, Ministral, Devstral and renamed merges included), not only by their names.

**Banned words not keeping words out** — *fixed in 1.7.8.* The list banned every piece of every word and phrase it was given, so a phrase took its everyday words with it ("her", "down"), a word that splits into pieces banned fragments other words share, and the slider's far end was only a strong nudge. It now bans a word at its own token, stops a phrase at its rarest word, never bans a common word or a fragment, and at -100 bans outright. **CHECK** under the list shows exactly what gets banned with the model you have loaded. It still works on the model's tokens, not on spelling, so single words work best.

**Mistral Small models talking nonsense** — *fixed in 1.7.2.* Cydonia, Magidonia and other Mistral Small 24B descendants would ignore their character entirely and answer in French, or start writing academic papers. The cause was one character: GobboNet was framing the conversation with a space where those models expect none, which was enough to stop them recognising that a conversation was happening at all. They now use their own built-in formatting. This was previously listed here as "Tekken tokenizer models misbehave".

---

## Upcoming changes

Same honesty policy as the bug list: here's what's actually queued, and roughly when we expect it to land. No dates promised — this is a list of intent, not a contract.

Between 1.5.8 and 1.6
- PDF handling — attach a PDF and have the AI actually read it, rather than being limited to plain text.
- Mac / Linux / Android port — Linux shipped in 1.7: a `.deb`, an `.rpm`, the ZIP, and from 1.7.8 an AppImage. Mac and Android are what's left.
- Model list moves to a GoblinCorps web call — the download menu currently ships with a fixed list baked into the files. Pulling it from our site instead means new and better models can show up in your menu without you reinstalling anything. We’ll be using an ‘add model’ button in the config menu that’ll let you download more models directly from huggingface.

Between 1.6 and v2.0
- Security update — a general pass over how the app protects itself and your data.
- Cloud complement — optional support for cloud models, shipped as a mod rather than baked into the app, because the whole service should stay private unless you explicitly say otherwise.
- Temperature / top-k on the carousel — save response settings alongside each system prompt, so swapping prompts also swaps the feel of the replies. More variance between them without hand-tuning every time.
- ~~Canvas side panel — a proper side panel for long code blocks and documents, with syntax highlighting, instead of everything being crammed into a chat bubble.~~ Shipped in 1.8.0 as the Files panel.
- ~~Auto-swipe on a bad entry — if a reply trips a banned word, reroll it automatically instead of making you do it by hand.~~ Shipped in 1.8.0 as Auto Reroll.
- Optional flags on all fields — per-field toggles across the app. Honest note: this one may turn out redundant, and we'll drop it if it does.
- Smoother alternate greetings — make moving between a character's different opening lines feel less clunky.
- ~~Undo button — take back the last thing you did.~~ Shipped in 1.7.9: deleting almost anything offers UNDO for 10 seconds.
- ~~Group chat — more than one character in the same conversation.~~ Shipped in 1.8.0: **+ GROUP** in the sidebar.
- User-controlled information hierarchy — you decide what gets sent to the model first, and what gets pushed down the list when space runs short.
- TTS / STT — speak to it, and have it speak back.

---

## Quick reference

| I want to… | Do this |
|---|---|
| Install it | Download and run `GobboNetSetup.exe` from Releases |
| Start the chat | Open **GobboNet** from the Start Menu or desktop |
| Use it on my phone | Run **LAN Setup** from the Start Menu once, then use the address shown |
| Change my password | Delete `.gobbonet-secret` and relaunch (or `launch.bat reset-password`) |
| Add another AI model | Config → **Add a Model**, put a `.gguf` file in the `models` folder, or open **Setup or add a model** from the Start Menu |
| Turn on web search | Paste a free Ollama key into Settings |
| Shut it down | Close the green launcher window |

---

## Full feature list

Everything GobboNet can do, grouped so it's easy to scan.

**Chatting**
- Streaming responses — replies appear word-by-word in real time as the AI thinks.
- Stop button — cut off a reply mid-sentence whenever you want.
- Reroll — not happy with an answer? Regenerate it with one click.
- Copy, edit, delete, or reroll any individual reply.
- UNDO — deleting a chat, message, folder, character, persona, memory file, macro, mod or server backup, and PURGE, shows UNDO for 10 seconds (or press Ctrl+Z). Removing a tag or a scheduled message asks first instead.
- Copy button on code blocks — grab code in one tap.
- Token counter — see how much of the AI's "memory" you're using.
- Chain-of-thought (reasoning) view — on models that support it, you can watch the AI's step-by-step thinking.
- Output token limitations + smart cutoff cutoff feature
- Auto-stop on stuck reasoning — if the AI's thinking gets caught in an endless loop, it's cut off automatically instead of running forever.

**Conversations & organizing**
- Landing page — a home dashboard you start from each time.
- A one-minute tour — offered once on a fresh install, and any time from Config → Basics → **SHOW ME AROUND**.
- Settings in five sections (Basics, Characters & Chat, Model & Performance, Devices & Network, Advanced) with a search box that finds any setting.
- Conversation threads — every chat is saved separately, like a history list.
- Rename any thread; copy, edit, or delete threads.
- Search your conversations — find an old chat by what was said in it.
- Folders, tags, and pins — sort chats into folders, label them with tags, and pin your favorites to the top.
- Branching conversations — fork a chat at any point to explore a different direction without losing the original.
- Memory + summarization — older parts of a long chat are automatically summarized so the AI keeps remembering what matters.
- Drag-and-drop file attachments — drag a file straight into the chat to attach it.
- Files panel — the 📄 button opens a panel beside the chat with every file in the conversation: what characters write as files, text files you attach, and web pages or pictures written as code. Writing the same file again makes a new version, with arrows to step through them. Markdown and CSV show rendered, and web pages run as a preview that cannot reach the internet or GobboNet. Edit a file and hand your version back with your next message, or select part of it and ask about just that. Honest note: a preview's scripts start switched off; one click turns them on for that file.

**Characters & personas**
- Default characters — comes with ready-made personalities to chat with right away, including the Gobbonet Informant, a guide that answers questions about GobboNet itself. When a newer version of one ships, its tile says **UPDATE**.
- Character cards — build your own detailed characters (name, description, personality, style, settings).
- Import and export character cards (V2/V3) — bring in the standard `.png` character cards used by other popular AI chat apps, and export your own back out in the same format. Cards are cross-compatible both directions, so you don't have to recreate a library you already own. Honest note: most cards carry over cleanly, but some may need a little tweaking after import.
- Lorebook import — embedded lorebooks come across with their underlying information preserved, and card details like creator, tags, version, and notes are kept and handed back when you export. Now fully exposed. Honest note: an imported lorebook is flattened into always-on lore rather than staying keyword-triggered, so all the content is there, it just arrives as one block instead of firing on cue.
- Memory files — give a character `.md` notes (a quest log, a journal) and it reads back the parts that matter to the moment. When a character writes a file in a reply, **Save to memory** keeps it, and saving a newer version replaces the old one. Matched by meaning with the small retrieval model, by shared words without it. See `docs/RAG_INFO.md`.
- User-controlled RAG lorebook — give a character a lorebook and GobboNet pulls in only the parts that matter to the current moment, using two approaches at once: meaning-based matching (via the small retrieval model) and weighted tag matching for lore you've structured yourself. Honest note: it degrades gracefully — if the retrieval model isn't running, tag matching carries on by itself and chat is never blocked.
- Lorebook + RAG lorebook work together to auto-update new information from extended conversations.
- lorebooks travel with the card — export a character and its lorebook rides along inside the file, so sharing a character shares everything it knows.
- Copy, edit, or delete characters.
- Group chats — put several characters in one conversation. **+ GROUP** in the sidebar starts one; a group is made in // CHARS like a character card: pick its members, drag them into a turn order, and give yourself a place in it or not. Choose who speaks next: in turn, whoever you name (natural), shuffled, by hand, or let a DM decide who is best to respond. In the chat you can mute a member, have one reply now, let the next one speak with **NEXT**, or switch on **AUTO** and watch them carry on. Honest note: one model plays everyone, one reply at a time, so a round of four characters takes four replies, and on a long chat each one starts with a pause while the model reads the conversation again as that character.
- Custom code for individual character cards — attach a small piece of JavaScript to a single character. It runs only while that card is active and is torn down the moment you switch away. Honest note: it is not sandboxed. It runs with the same access as the page does, exactly like the mod controls below — your machine, your card, your code.
- Tools from a character's code — custom code can offer the model functions to call (`gobbo.tool(...)`). The model calls them only while **Let the model call this card's tools** is ticked on that card, and imported cards arrive with it off. CONFIG > Characters & Chat > Card Tools sets how many calls a reply may make and how long each may take.
- MCP servers — set up MCP servers, small programs on your PC that offer tools (a file reader, a notes database, a git helper), in CONFIG > Advanced > MCP Servers. **PASTE A SETUP (JSON)** fills the form from the block most servers document, and **CHECK TOOLS** lists what each one offers. Honest note: this release sets them up and checks them; characters calling their tools in a chat comes later.
- Alternate greetings — give a character several different opening lines.
- User personas — create a profile for *yourself* so the AI knows who it's talking to.
- Avatar, background, and text-color customization — make each character and the chat look the way you want.

**Writing & macros**
- `{{char}}` and `{{user}}` placeholders — automatically fill in the character's and your name as you chat.
- `{{current_DAT}}` — lets the AI know the current date and time.
- Built-in macros like `{{continue}}` and `{{fast_forward}}` to nudge a story or task along.
- `{{auto_continue_x}}` — keeps a story or task running on its own so it makes progress while you step away.
- Custom macros — create your own shortcuts for text or actions you use a lot. A macro can take text: `{{SYSTEM: keep it short}}` (or `{{SYSTEM:}} keep it short` for the rest of the line) sends the model an out-of-character note, ready-made. In your own macros, `{{input}}` marks where the text goes, and `{{input1}}`, `{{input2}}`… take pieces split at `|`.

**The AI's behavior (controls)**
- System prompt editing — change the underlying instructions that shape how the AI behaves.
- System prompt carousel — save several system prompts and swap between them quickly.
- Response controls — fine-tune things like temperature and top-k to make replies more focused or more creative.
- Banned words — keep specific words out of a character's replies, from a nudge to an outright ban. Single words work best; CHECK shows what gets banned.
- Auto Reroll — give a character a list of off-limits words, and a reply that uses one is stopped and written again, up to the number of tries you choose. It reads the reply itself, never the thinking, so it catches what banned words let through: the two work best together. Honest note: each try is a new reply, so it costs time, and if every try still uses a word the last one is kept and marked.
- Model selector — choose which AI model you're talking to.
- Model hot-swap — switch to a different downloaded model without restarting anything.
- Model links — a chat remembers the model that wrote it, and a character can name the model it was made for. Opening the chat, or starting one with that character, offers to switch; CONFIG > Characters & Chat > Model Switching can make it switch on its own, or never.
- GPU menu — choose which graphics card runs the model, from the list the engine itself sees, in CONFIG > Model & Performance > Performance. `gobbonet doctor` says which card and which engine build are in use, and why.
- When a model won't load, the chat says why in plain words (not enough memory, an incomplete download, a model this engine can't read), and **CHECK FILE** in Add a Model tests a download against its checksum. Every model in the catalogue has one pinned.
- Add a Model — sixteen models to download, filtered by what they are good at and by size (Light, Medium, Heavy, Mixture of Experts), each checked before use. **FOUND ON THIS COMPUTER** offers models you already have from HuggingFace or another app, used in place without copying.

**Web search (optional)**
- Search the web — let the AI look things up online (needs a free Ollama key).
- Privacy protection — your GobboNet session cookie and login token are dropped before a search leaves your machine, so the search provider never sees them. What does go is the search text as you typed it, along with your Ollama key, because that is what a search is. Chat messages are never included.

**Saving & getting things out**
- Save AI output as a `.txt` or `.json` file. (Other file types are intentionally left out for now to keep things simple and safe.)
- Export, import, or purge all your data — back up everything to a file, restore it later, or wipe it completely.

**Customization (advanced)**
- Mods — stylesheets and scripts that change how the app looks and works, each with its own switch and load order. Write your own in the MODS panel (they are kept as the mod "My extensions", and each stylesheet or script in it has its own switch too), or drop a folder with a `mod.json` into GobboNet's `mods` folder. Mods are added and switched on only from the PC GobboNet runs on, so another device can never push code to you. ENDORSED MODS in the same panel lists mods Elodine endorses at [goblincorps.com/gobbonet_extras](https://goblincorps.com/gobbonet_extras), installed with one click and checked file by file against the list's SHA-256 pins. A mod that breaks while loading switches itself off.

**Scheduling**
- Scheduled tasks — set prompts to send themselves at specific times.
- Copy, edit, or delete scheduled tasks.

**Devices**
- PC-to-phone connection — use the same chat from your phone or tablet over your home Wi-Fi.
- Start without a new tab — CONFIG > Basics > When GobboNet Starts turns off the browser tab GobboNet opens each time it starts, for when you keep a tab open or use it from your phone.

**Updates**
- CHECK FOR UPDATES in ABOUT — asks GitHub for a newer GobboNet, only when you press it, and installs one only if the maintainer signed it. It never goes back to an older version, and your chats, models and settings are left alone. Honest note: a `.deb` or `.rpm` install is updated with the new package; the button links the release page instead.

---

## Where everything lives

The folder used to open on 57 files with the launcher buried among twenty
changelogs. Docs and developer tooling now sit in their own folders. Nothing was
deleted, and nothing you run has moved.

| | |
|---|---|
| `launch.bat` | The launcher. Still the first thing you run: it asks the questions, fetches the engine and the model, then hands over to `gobbonet.exe` in the same window. |
| **`gobbonet.exe`** | **GobboNet itself — the server, with the chat screen inside it. This is the one file an update replaces.** |
| `setup-lan.bat`, `stop-gobbonet.bat`, `teardown-lan.bat` | Phone access on/off, and shutdown. |
| `gobbonet`, `linux-amd64/` | The Linux program and its bundled engine. |
| `web\` | The chat interface GobboNet is actually serving. Written by `gobbonet.exe` on startup, and replaced when you update. Edit it and reload to see changes. |
| `chat.html`, `js/`, `css/` | The **source** those files are built from, kept so you can read and diff it. Editing the source changes nothing until it is recompiled — edit `web\` instead. |
| [`docs/`](docs/) | Reference material, plus [`docs/changelog/`](docs/changelog/) — one write-up per fix. |
| [`tests/`](tests/) | Developer tests and browser preview pages. Not needed to run anything. |
| `internal/`, `cmd/` | The Go server's source. |
| `installer/`, `installer-linux/`, `installer-fedora/` | How the Windows `.exe` and the Linux `.deb`/`.rpm` are built. |

**Want to change how the chat looks?** Edit the files in the `web\` folder and
reload the page. GobboNet writes that folder itself on startup and serves it, so
what is on disk is exactly what you get — nothing is hidden inside the program.

One catch worth knowing: `web\` is **replaced when you update**, because that is
how a new version reaches the chat screen. The launcher window says so when it
happens. To keep changes across updates, copy them somewhere else and point
GobboNet at that folder instead:

```
gobbonet config set web_root "C:\Users\you\my-gobbonet-theme"
```

Only the files you put there override the built-in ones, so a folder holding one
CSS file changes that one thing and leaves the rest alone. Remove the setting to
go back to normal.

`README.md`, `TROUBLESHOOTING.md` and `SECURITY.md` stay at the root, because
that is where you would look for them and because the launcher points at the
last two by name.

---

## How I handle PRs. 

I'm one highly paranoid goblin and I ship a .exe that non-technical people install, so I need to understand every line that goes out. In practice that means I often reimplement a fix in my own code rather than merging the patch **especially** for security issues. You'll be credited as co-author on the commit and named in the release notes. If I close your PR, it usually means it shipped, not that it was rejected. Bug reports and security findings are hugely welcome even if you don't write a line of code.

---

*GobboNet is brought to you by the GoblinCorps. No corpo money, no venture capital, no masters.*
