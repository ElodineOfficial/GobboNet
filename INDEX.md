# Gobbonet `chat.html` — Structural Index

> **File:** `chat.html` | **Total lines:** ~11,402 | **Single-page application (no routing, all inline)**

---

## How views work

There are no separate pages or routes. All "views" are either:
- **Rendered into `#chat`** by JavaScript functions called from `render()` / `goHome()`
- **Shown/hidden modals** (full-screen overlays toggled via CSS class `open`)
- **Sub-views** within a modal (e.g. char list ↔ card editor ↔ persona editor)

The sidebar (`#sidebar`) is always visible (collapsible) and renders the thread list + footer buttons.

---

## 1. Layout Shell (always present)

| ID / Class | Line | Purpose |
|---|---|---|
| `#app` | 609 | Root container |
| `#sidebar` (aside) | 611 | Collapsible sidebar with thread list |
| `#sidebar-overlay` | 643 | Tap-to-dismiss overlay for mobile |
| `#chat` (main) | 646 | Main chat area |
| `#messages` | 663 | Message stream container |
| `#context-info` | 670 | Token usage bar |
| `#auto-continue-indicator` | 671 | Auto-continue progress bar |
| `#attach-tray` | 672 | Attached file indicators |
| `.input-area` | 673 | Message input + send + stop + search buttons |
| `#drop-overlay` | 695 | Drag-and-drop overlay |

---

## 2. Main Views (rendered into `#chat`)

### 2A. Chat View (active thread conversation)

| Item | Line | Notes |
|---|---|---|
| HTML shell | 646–693 | Header, messages area, input area |
| `renderMessages()` | **7848** | Renders all messages for active thread |
| `renderStreamingUpdate()` | 8569 | Surgical SSE update (avoids full re-render) |
| `renderSidebar()` | 7527 | Thread list rendering |
| `renderThreadItem(t)` | 7487 | Single thread entry in sidebar |
| `updateContextInfo()` | — | Token bar update |

### 2B. Landing Page / Dashboard

| Item | Line | Notes |
|---|---|---|
| `renderLandingPage()` | **7731–7847** | Returns HTML string for dashboard |
| `goHome()` | **8505** | Clears active thread → shows landing page |
| `.landing-header` | 7817 | Title, connection status, privacy badge |
| `.landing-section` (scheduled tasks) | 7820 | Lists active/done scheduled tasks |
| `.landing-section` (your characters) | 7826 | Active character list with "Manage" button |
| `.landing-section` (default presets) | 7832 | Installable preset characters |
| `.landing-char-card` | 7768 | Clickable character card on landing |
| `.landing-preset-card` | 7796 | Installable preset (from `default-characters.json`) |
| `installDefaultChar(idx)` | 8510 | Installs a preset as a new character card |

---

## 3. Modals (overlay dialogs, toggled via `classList.add('open')`)

### 3A. Settings Modal

| ID | Line | Purpose |
|---|---|---|
| `#settings-modal` (backdrop) | 706 | Full modal wrapper |
| API Key input | 734 | Ollama API key for web search |
| Search test button | 736 | Tests API key connectivity |
| Token limit input | 750 | Context size configuration |
| COT timeout section | 755 | Chain-of-thought auto-stop |
| Avatar scale slider | 722 | Global avatar size control |
| `openSettings()` | 8659 | Opens modal |
| `closeSettings()` | 8674 | Closes modal |

### 3B. Characters Modal

| ID | Line | Purpose |
|---|---|---|
| `#char-modal` (backdrop) | 789 | Full modal wrapper |
| `#char-modal-list` | 794 | **Sub-view: list of cards + personas** |
| `#card-grid` | 800 | Character cards grid |
| `#persona-grid` | 813 | Persona cards grid |
| `#card-editor` | 818 | **Sub-view: character card editor** |
| `#persona-editor` | 1051 | **Sub-view: persona editor** |

#### Card Editor fields (inside `#card-editor`):

| Field ID | Line | Purpose |
|---|---|---|
| `#card-name` | 821 | Character name |
| `#card-avatar` | 829 | Avatar URL |
| `#card-style` | 840 | System prompt / writing style |
| `#card-carousel-enabled` | 845 | Carousel prompt toggle |
| `#card-carousel-prompts` | 849 | Rotating instructions |
| `#card-personality` | 873 | Personality / behavioral rules |
| `#card-lore-toggle` | 879 | Memory system on/off |
| `#card-starting-lore` | 888 | Pre-filled lore for new threads |
| `#card-rag-storybook` | 893 | User-controlled RAG storybook |
| `#card-greeting` | 901 | Opening greeting |
| `#card-alt-greetings` | 909 | Alternative greetings |
| `#card-bg` | 923 | Chat background URL |
| `#card-textcolor` / `#card-dialogcolor` | 939, 944 | Theme colors |
| `#card-temperature` | 960 | Temperature slider (0–2) |
| `#card-min-p` | 965 | Min P slider |
| `#card-top-k` | 973 | Top-K input |
| `#card-top-p` | 978 | Top-P slider |
| `#card-repeat-penalty` | 986 | Repeat penalty slider |
| `#card-repeat-last-n` | 991 | Repeat penalty window |
| `#card-xtc-prob` | 1003 | XTC probability |
| `#card-xtc-threshold` | 1008 | XTC threshold |
| `#card-dry-mult` | 1015 | DRY multiplier |
| `#card-banned-phrases` | 1023 | Banned words list (known bug) |
| `#card-logit-strength` | 1029 | Logit bias strength |

#### Persona Editor fields (inside `#persona-editor`):

| Field ID | Line | Purpose |
|---|---|---|
| `#persona-name` | 1059 | User's display name |
| `#persona-avatar` | 1068 | User's avatar URL |
| `#persona-description` | — | Description visible to AI |
| Color pickers | 1102 | User message colors |

#### Character Modal navigation:

| Function | Line | Action |
|---|---|---|
| `openCharacters()` | 8714 | Opens modal, shows list |
| `closeCharacters()` | 8726 | Closes modal |
| `renderCardGrid()` | 8732 | Renders character cards |
| `renderPersonaGrid()` | 9692 | Renders persona cards |
| `editCard(id)` | 8871 | Switches list → card editor |
| `cancelCardEdit()` | 8921 | Switches editor → list |
| `saveCard()` | 8935 | Saves character card |
| `deleteCard()` | 9765 | Deletes character card |
| `editPersona(id)` | 9785 | Switches list → persona editor |
| `cancelPersonaEdit()` | 9815 | Switches editor → list |

### 3C. Scheduler Modal

| ID | Line | Purpose |
|---|---|---|
| `#sched-modal` (backdrop) | 1123 | Full modal wrapper |
| `#sched-list` | 1127 | Task list |
| `#sched-editor` | 1129 | Create/edit form (hidden by default) |
| `#sched-time` | 1133 | Time input (24hr) |
| `#sched-thread` | 1137 | Thread selector |
| `#sched-prompt` | 1143 | Prompt text |
| `#sched-recurring` | 1148 | One-time vs daily |
| `#sched-search` | 1155 | Web search toggle |
| `createSched()` | — | Creates new scheduled task |
| `saveSched()` | — | Saves edit |
| `cancelSchedEdit()` | — | Cancels edit |
| `renderSchedList()` | 11101 | Renders task list |
| `openScheduler()` | 11089 | Opens modal |
| `closeScheduler()` | 11097 | Closes modal |

### 3D. Extensions / MODS Modal

| ID | Line | Purpose |
|---|---|---|
| `#ext-modal` (backdrop) | 1173 | Full modal wrapper |
| `#ext-enabled` | 1195 | Master toggle (enable/disable all) |
| `#ext-styles-list` | 1206 | Stylesheet entries |
| `#ext-scripts-list` | 1222 | Script entries |
| `#macro-list` | 1235 | Custom macro list |
| `#macro-editor` | 1238 | Add/edit macro form |
| `#macro-trigger` | 1242 | Macro trigger name |
| `#macro-text` | 1248 | Macro expansion text |
| `#ext-status-list` | 1256 | Currently loaded extensions status |
| `openExtensions()` | 10578 | Opens modal |
| `closeExtensions()` | 10593 | Closes modal |
| `addExtEntry(kind)` | — | Adds stylesheet or script entry |
| `previewExtCSS()` | — | Live CSS preview without saving |
| `saveExtensions()` | — | Saves and applies extensions |
| `clearAllExtensions()` | — | Removes all extension data |
| `renderMacroList()` | 10728 | Renders macro entries |
| `showMacroEditor(triggerName)` | 10748 | Shows macro edit form |
| `saveMacroEdit()` | — | Saves macro |
| `cancelMacroEdit()` | — | Cancels macro edit |
| `renderExtEntryList(kind)` | 10685 | Renders stylesheet/script entries |

### 3E. Data Manager Modal

| ID | Line | Purpose |
|---|---|---|
| `#data-modal` (backdrop) | 1265 | Full modal wrapper |
| Export buttons | 1272 | Threads / Characters / Personas / Full Backup |
| Import file inputs | 1293 | JSON file importers |
| `#import-status` | 1314 | Import result display |
| Purge buttons | 1320 | Delete threads / characters / personas / all |
| `openDataManager()` | 11077 | Opens modal |
| `closeDataManager()` | 11081 | Closes modal |
| `exportData(kind)` | — | JSON export |
| `importData(input, kind)` | — | JSON import |
| `purgeData(kind)` | — | Data deletion |

### 3F. About Modal

| ID | Line | Purpose |
|---|---|---|
| `#about-modal` (backdrop) | 1331 | Full modal wrapper |
| App branding | 1335 | GOBBONET title + subtitle |
| Feature list | 1341 | Private-by-design info, version, credits |
| `openAbout()` | 11305 | Opens modal |
| `closeAbout()` | 11308 | Closes modal |

---

## 4. Popovers (ephemeral inline overlays)

| Function | Line | Purpose |
|---|---|---|
| `openPopover(anchorEl, html)` | 7309 | Creates floating popover |
| `closePopover()` | 7335 | Removes popover |
| `openFolderPicker(threadId, event)` | 7393 | Folder assignment popover |
| `openTagEditor(threadId, event)` | 7415 | Tag editor popover |

---

## 5. Key JavaScript Functions (by category)

### State Management
| Function | Line | Purpose |
|---|---|---|
| `render()` | 7263 | Top-level render (sidebar + messages) |
| `loadState(rawOverride)` | 3124 | Loads state from localStorage / server |
| `saveState()` | — | Persists state |

### Model / Server
| Function | Line | Purpose |
|---|---|---|
| `loadActiveModel()` | 1555 | Loads currently active model metadata |
| `loadModelsList()` | 1735 | Loads available models from server |
| `showModelSwitchToast(msg, kind, ms)` | 1906 | Shows swap progress toast |
| `sendMessage()` | — | Sends user message to llama-server |
| `stopGeneration()` | — | Abort streaming |
| `followToBottom()` | — | Scroll to last message |

### Message Handling
| Function | Line | Purpose |
|---|---|---|
| `renderMessages()` | 7848 | Renders all messages in active thread |
| `renderStreamingUpdate()` | 8569 | Surgical SSE token-by-token update |
| `renderReminderIndicator()` | 8143 | Shows reminder for follow-up |
| `renderSearchIndicator(status)` | 8151 | Web search status indicator |
| `renderLoreIndicator(status)` | 8166 | Lore/memory system status |
| `renderAttachTray()` | 10326 | Shows attached files |

### Thread Management
| Function | Line | Purpose |
|---|---|---|
| `renderSidebar()` | 7527 | Renders thread list + folders |
| `renderThreadItem(t)` | 7487 | Single thread entry HTML |
| `togglePin(id, event)` | — | Pin/unpin thread |
| `deleteThread(id, event)` | — | Delete thread |
| `startRename(id, event)` | — | Inline rename |
| `filterThreads()` | — | Search/filter sidebar |
| `clearThreadSearch()` | — | Clear search input |

### Sidebar & Navigation
| Function | Line | Purpose |
|---|---|---|
| `goHome()` | 8505 | Navigate to landing page |
| `toggleSidebar()` | 8540 | Toggle sidebar visibility |
| `updateSidebarVisibility()` | — | CSS class management |

### Utilities
| Function | Line | Purpose |
|---|---|---|
| `renderAvatar(avatarStr, name)` | 4510 | Avatar rendering (URL, icon, or image) |
| `previewAvatar(inputId, previewId)` | — | Live image preview |
| `previewAvatarScale(value)` | — | Avatar scale preview |
| `previewCardColors()` | — | Character color preview |
| `previewBg()` | — | Background preview |
| `syncColorHex(el, hexId)` | — | Sync color picker ↔ hex input |
| `syncColorSwatch(el, colorId)` | — | Sync hex input ↔ color picker |
| `getTagColor(name)` | 7285 | Deterministic tag color from name |
| `generateId()` | — | Unique ID generator |
| `escapeHtml(str)` | — | HTML escaping |
| `gobboDiag()` | 4056 | Diagnostic/debug function |
| `showRestorePrompt(info)` | 3873 | Data loss recovery prompt |

### Lore & RAG System
| Function | Line | Purpose |
|---|---|---|
| Lore compression | ~3100+ | Automatic lore generation for long threads |
| RAG storybook | ~3200+ | User-controlled storybook with weighted tags |
| `updateStorybookReadout()` | — | Shows storybook tag weight summary |

### File Attachments
| Function | Line | Purpose |
|---|---|---|
| `onAttachInput(input)` | — | Handles file input selection |
| `renderAttachTray()` | 10326 | Displays attached files |
| Drag-and-drop handlers | ~3600+ | Drop overlay + file reading |

---

## 6. CSS Classes (by functional group)

### Landing Page
`.landing-page`, `.landing-header`, `.landing-title`, `.landing-subtitle`, `.landing-section`, `.landing-section-header`, `.landing-sched-list`, `.landing-sched-item`, `.landing-sched-time`, `.landing-sched-type`, `.landing-sched-thread`, `.landing-sched-prompt`, `.landing-sched-done`, `.landing-sched-active`, `.landing-char-list`, `.landing-char-card`, `.landing-char-avatar`, `.landing-char-info`, `.landing-char-name`, `.landing-char-desc`, `.landing-char-badge`, `.landing-char-active`, `.landing-preset-card`, `.landing-preset-icon`, `.landing-preset-badge`, `.landing-preset-badge-install`, `.landing-empty`, `.landing-status-ok`, `.landing-status-err`, `.landing-hint`, `.landing-tag`

### Sidebar
`.sidebar-header`, `.sidebar-header-row`, `.sidebar-footer`, `.sidebar-footer-btns`, `.thread-list`, `.thread-search-wrap`, `.thread-search-input`, `.thread-search-icon`, `.thread-search-clear`, `.thread-item`, `.thread-pinned`, `.thread-body`, `.thread-name-row`, `.thread-name`, `.thread-ctrl`, `.thread-ctrl-btn`, `.thread-pin-btn`, `.thread-folder-btn`, `.thread-tag-btn`, `.thread-edit-btn`, `.thread-del-btn`, `.folder-empty`, `.empty-threads`

### Chat Messages
`.messages`, `.welcome`, `.message`, `.message-user`, `.message-assistant`, `.message-actions`, `.message-text`, `.message-avatar`, `.message-time`, `.message-variant-nav`, `.message-content`, `.message-code`, `.message-code-header`, `.message-code-copy`, `.message-save-btn`, `.cot-block`, `.cot-summary`, `.cot-content`, `.cot-active`, `.message.archived`, `.lore-divider`, `.lore-divider-icon`

### Modals
`.modal-backdrop`, `.modal`, `.modal-actions`, `.form-group`, `.form-hint`, `.form-row`, `.btn`, `.btn-fill`, `.btn-block`, `.btn-danger`, `.btn-sm`, `.ext-btn`

### Extensions / MODS
`.ext-modal`, `.ext-section`, `.ext-section-header`, `.ext-toggle-wrap`, `.ext-toggle-label`, `.ext-warning-box`, `.ext-warning-icon`, `.ext-status-panel`, `.ext-status-header`, `.ext-status-list`, `.macro-row`, `.macro-preview`

### Data Manager
`.data-section`, `.data-section-header`, `.data-section-body`, `.data-section-danger`, `.data-import-status`

### Scheduler
`.sched-item`, `.sched-item-header`, `.sched-item-body`, `.sched-item-time`, `.sched-item-thread`, `.sched-item-prompt`, `.sched-item-actions`, `.sched-active`, `.sched-done`

### Popovers
`.sidebar-popover`, `.pop-list`, `.pop-tag-editor`

---

## 7. Data Structures (state object)

The entire app state lives in a single `state` object persisted to `localStorage` and synced via `/state` endpoint:

| Property | Description |
|---|---|
| `state.threads[]` | Conversation threads (id, name, characterId, messages[], folderId, tags[], pinned, forkSource) |
| `state.folders[]` | Thread folders (id, name, collapsed) |
| `state.characterCards[]` | Character/persona cards (id, name, avatar, writingStyle, personality, sampler settings, etc.) |
| `state.activeThreadId` | Currently selected thread or `null` (landing page) |
| `state.activeCardId` | Currently active character |
| `state.activePersonaId` | Currently active user persona |
| `state.schedules[]` | Scheduled tasks (time, threadId, prompt, recurring, useSearch, lastFired) |
| `state.extensions` | Stylesheets, scripts, macros config |
| `state.apiKey` | Ollama API key (for web search) |
| `state.contextLimit` | Token limit |
| `state.cotTimeout` | Chain-of-thought auto-stop timeout |
| `state.avatarScale` | Global avatar scale factor |
| `state.sidebarOpen` | Sidebar visibility toggle |
| `state.activeModel` | Current model filename |

---

## 8. File Attachment Flow

| Step | Line |
|---|---|
| Drop overlay (`#drop-overlay`) | 695 |
| `onDrop(e)` handler | ~3600+ |
| `handleDrop(e)` | — |
| Read file content (text → context, images → base64) | — |
| `onAttachInput(input)` | — |
| `renderAttachTray()` | 10326 |
| Include in message payload | — |

---

## 9. Macro System

| Macro | Expansion |
|---|---|
| `{{char}}` | Active character name |
| `{{user}}` | Active persona name |
| `{{current_DAT}}` | Current date/time |
| `{{continue}}` | Continue generation prompt |
| `{{fast_forward}}` | Fast-forward narrative |
| `{{auto_continue_N}}` | Auto-continue for N turns |
| `{{<custom>}}` | User-defined macros in `state.extensions.macros` |

---

*Generated automatically from `chat.html` structure analysis.*
