/* @gobbonet-split js/27-files-panel.js
   Hand-written module -- NOT produced by refactor-split.py.
   The Files panel (1.8.0): a conversation's files, beside it.
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   FILES PANEL

   The panel on the right of the chat, as other chat front ends have it
   (Claude's artifacts, ChatGPT's canvas, Open WebUI's and LibreChat's
   artifacts): the files in this conversation, each opened whole, with a
   preview where one makes sense, every version, and a way to edit one
   and hand it back.

   WHAT COUNTS AS A FILE. Nothing new is stored: the panel reads the
   conversation as it stands.
     - A ```file:name block in any message -- the form GobboNet's
       characters already use to write a file. The same name written
       again is a new version of the same file.
     - A text file you attached to a message (📎). Attaching an edited
       version from the panel is how your own version enters the
       conversation, so it becomes a version too, by "You".
     - A plain ```html or ```svg code block, which can be previewed: it
       is listed as untitled-1.html and so on, one entry each.
   Only what the chat shows counts: the version of each message on
   screen, the text after {{char}} and friends are filled in.

   PREVIEWS. Markdown is rendered by the chat's own renderer, CSV and TSV
   as a table, and HTML and SVG in a sandboxed frame:
     - sandbox without allow-same-origin: the page runs as nobody, with no
       cookie, no session and no way into GobboNet's page or data;
     - a Content-Security-Policy, put first in the document, that lets it
       load nothing from anywhere: no scripts, styles, pictures or fonts
       from the internet, and no fetch -- so it cannot reach GobboNet's
       own server either, which answers CORS "*";
     - scripts off until you press RUN SCRIPTS for that file, unless CONFIG
       says to run them; a page cannot then even try to send anything;
     - a page that opens another address (a link, a redirect) is stopped
       and replaced with a note. That is the one thing a policy cannot
       forbid a page outright, which is why scripts start off.
   Nothing here is sent anywhere, and nothing reaches the model that you
   do not attach yourself.

   EDITING. EDIT turns the file into a text box. USE IN MY NEXT MESSAGE
   attaches what is in it to your next message under the same name, so
   the character reads your version and can write the next one; ASK
   ABOUT THE SELECTION does the same and quotes the part you selected
   into the message box.

   Built with createElement and textContent. The two innerHTML sinks
   take the chat's own renderers' output -- parseMarkdown and
   highlightCode -- which escape everything they are given.
================================================================ */

const FILES_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'";
const FILES_CSV_MAX_ROWS = 500;
const FILES_CSV_MAX_COLS = 50;
const FILES_NAME_MAX = 200;
// Below this width the panel covers the chat instead of sitting beside it,
// and a reply never opens it by itself.
const FILES_OVERLAY_BELOW = 900;
const FILES_AUTO_OPEN_FROM = 1100;
const FILES_WIDTH_MIN = 300;
const FILES_WIDTH_DEFAULT = 460;
const FILES_PREFS_KEY = 'gobbonet.filesPanel';

const _fp = {
  open: false,
  key: null,          // the file on view; null = the list
  version: null,      // its version index; null = the latest
  tab: null,          // 'preview' | 'code'; null = the file's default
  editing: false,
  editText: '',
  run: new Set(),     // key|version pairs whose scripts may run this session
  files: [],
  sig: '',
  threadId: null,
  streamTimer: null,
  width: FILES_WIDTH_DEFAULT,
};

/* ---- What a file is --------------------------------------------------- */

/** How a file is shown, from its name (or a code block's language). */
function filesTypeOf(name) {
  const m = /\.([A-Za-z0-9_+-]+)$/.exec(String(name || ''));
  const ext = m ? m[1].toLowerCase() : '';
  if (ext === 'md' || ext === 'markdown') return { ext, kind: 'markdown', lang: 'markdown', preview: true };
  if (ext === 'html' || ext === 'htm' || ext === 'xhtml') return { ext, kind: 'html', lang: 'html', preview: true };
  if (ext === 'svg') return { ext, kind: 'svg', lang: 'xml', preview: true };
  if (ext === 'csv') return { ext, kind: 'csv', lang: 'csv', preview: true };
  if (ext === 'tsv') return { ext, kind: 'tsv', lang: 'tsv', preview: true };
  return { ext, kind: 'code', lang: ext || 'text', preview: false };
}

function _filesCleanName(raw) {
  return String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, FILES_NAME_MAX) || 'file.txt';
}

const _FILES_ATTACH_RE = /----- FILE: (.+?) -----\n([\s\S]*?)\n----- END FILE: \1 -----/g;

/**
 * The files in a conversation: [{ key, name, type, versions: [{ msgIndex,
 * fence, source, author, content, closed, truncated }] }], the most recently
 * written first. fence is the block's data-fence, or -1 for an attachment.
 */
function scanConversationFiles(thread) {
  if (!thread || !Array.isArray(thread.messages)) return [];
  const byKey = new Map();
  let untitled = 0;
  let cast = null;
  try { cast = makeCastResolver(thread); } catch (e) {}
  const add = (key, name, v) => {
    let f = byKey.get(key);
    if (!f) { f = { key, name, type: filesTypeOf(name), versions: [] }; byKey.set(key, f); }
    // The latest spelling of the name wins: "Notes.md" then "notes.md".
    f.name = name;
    f.type = filesTypeOf(name);
    f.versions.push(v);
    f.last = v.msgIndex;
  };
  thread.messages.forEach((m, mi) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') return;
    const isUser = m.role === 'user';
    let cardName = 'Assistant', userName = 'You';
    try { if (cast) { cardName = (cast.cardFor(m) || {}).name || cardName; userName = (cast.personaFor(m) || {}).name || 'Anonymous'; } } catch (e) {}
    const author = isUser ? 'You' : cardName;
    if (isUser && typeof m.attachmentText === 'string' && m.attachmentText.indexOf('----- FILE: ') >= 0) {
      _FILES_ATTACH_RE.lastIndex = 0;
      let a;
      while ((a = _FILES_ATTACH_RE.exec(m.attachmentText)) !== null) {
        const name = _filesCleanName(a[1]);
        let content = a[2];
        const truncated = /\n\[\.\.\.truncated\]$/.test(content);
        if (truncated) content = content.replace(/\n\[\.\.\.truncated\]$/, '');
        add('f:' + name.toLowerCase(), name, { msgIndex: mi, fence: -1, source: 'attachment', author, content, closed: true, truncated });
      }
    }
    let text = isUser ? m.content : ((typeof unwrapToolCallText === 'function') ? unwrapToolCallText(m.content) : m.content);
    if (text.indexOf('```') < 0 && text.indexOf('~~~') < 0) return;
    try { text = translateTemplates(text, cardName, userName, true); } catch (e) {}
    for (const f of mdListFences(text)) {
      const fm = /^file:(.+)$/i.exec(f.info);
      if (fm) {
        const name = _filesCleanName(fm[1]);
        add('f:' + name.toLowerCase(), name, { msgIndex: mi, fence: f.idx, source: 'block', author, content: f.code, closed: f.closed });
        continue;
      }
      const lang = String(f.info || '').toLowerCase().split(/[ \t,]/)[0];
      if (FILES_PREVIEW_LANGS.test(lang)) {
        const ext = lang === 'svg' ? 'svg' : 'html';
        untitled++;
        add('c:' + mi + ':' + f.idx, 'untitled-' + untitled + '.' + ext,
            { msgIndex: mi, fence: f.idx, source: 'code', author, content: f.code, closed: f.closed });
      }
    }
  });
  return Array.from(byKey.values()).sort((a, b) => b.last - a.last);
}

/* A cheap fingerprint of what the scan reads, so the panel scans again only
   when the conversation changed. */
function _filesSig(thread) {
  if (!thread || !Array.isArray(thread.messages)) return '';
  let n = 0;
  for (const m of thread.messages) {
    if (!m) continue;
    n = (n * 31 + (typeof m.content === 'string' ? m.content.length : 0) + (m.attachmentText ? m.attachmentText.length : 0) + (m.activeVariant | 0)) % 1000000007;
  }
  return thread.id + '|' + thread.messages.length + '|' + n;
}

function _filesCurrent() {
  return _fp.files.find(f => f.key === _fp.key) || null;
}

function _filesVersionIndex(file) {
  if (!file) return -1;
  const last = file.versions.length - 1;
  if (_fp.version === null || _fp.version > last || _fp.version < 0) return last;
  return _fp.version;
}

/* ---- Previews ------------------------------------------------------------ */

/** The document a sandboxed frame shows for an HTML or SVG file. */
function filesPreviewDocument(content, kind) {
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + FILES_PREVIEW_CSP + '">';
  // A meta refresh is a way to go to another address with no script at all.
  const body = String(content || '').replace(/<meta\b[^>]*http-equiv\s*=\s*["']?\s*refresh[^>]*>/gi, '');
  if (kind === 'svg') {
    return '<!DOCTYPE html><html><head>' + meta + '<style>html,body{margin:0;height:100%}' +
      'body{display:flex;align-items:center;justify-content:center;background:#fff}svg{max-width:100%;max-height:100%}</style>' +
      '</head><body>' + body + '</body></html>';
  }
  // The policy goes before anything of the page's own, so nothing in it can
  // run or load before the policy applies: right after a doctype, or first.
  const dt = /^\s*<!doctype[^>]*>/i.exec(body);
  return dt ? dt[0] + meta + body.slice(dt[0].length) : '<!DOCTYPE html>' + meta + body;
}

function _filesFrame(content, kind, scripts, onStopped) {
  const f = document.createElement('iframe');
  f.className = 'files-frame';
  f.setAttribute('sandbox', scripts ? 'allow-scripts' : '');
  f.setAttribute('referrerpolicy', 'no-referrer');
  f.setAttribute('title', 'Preview');
  f.setAttribute('loading', 'lazy');
  let loads = 0;
  f.addEventListener('load', () => {
    loads++;
    // The first load is our document. Any later one means the page went
    // somewhere else; whatever it went to has no policy of ours on it.
    if (loads > 1) {
      try { f.srcdoc = ''; f.removeAttribute('src'); } catch (e) {}
      onStopped();
    }
  });
  f.srcdoc = filesPreviewDocument(content, kind);
  return f;
}

/** CSV or TSV text as rows of cells. Quotes, doubled quotes and line breaks
 *  inside quotes, as spreadsheets write them. */
function filesParseDelimited(text, sep) {
  const rows = [];
  let row = [], cell = '', q = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { q = true; continue; }
    if (c === sep) { row.push(cell); cell = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      if (rows.length > FILES_CSV_MAX_ROWS) break;
      continue;
    }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function _filesTable(text, sep) {
  const rows = filesParseDelimited(text, sep);
  const wrap = document.createElement('div');
  wrap.className = 'files-table-wrap';
  const table = document.createElement('table');
  table.className = 'files-table';
  rows.slice(0, FILES_CSV_MAX_ROWS).forEach((r, ri) => {
    const tr = document.createElement('tr');
    r.slice(0, FILES_CSV_MAX_COLS).forEach(c => {
      const td = document.createElement(ri === 0 ? 'th' : 'td');
      td.textContent = c;
      tr.appendChild(td);
    });
    table.appendChild(tr);
  });
  wrap.appendChild(table);
  if (rows.length > FILES_CSV_MAX_ROWS) {
    const note = document.createElement('div');
    note.className = 'files-note';
    note.textContent = 'Showing the first ' + FILES_CSV_MAX_ROWS + ' rows; CODE shows it all.';
    wrap.appendChild(note);
  }
  return wrap;
}

/* ---- The panel ------------------------------------------------------------ */

function _filesEls() {
  const id = x => document.getElementById(x);
  return { panel: id('files-panel'), body: id('files-body'), title: id('files-title'), back: id('files-back'),
           close: id('files-close'), toggle: id('files-toggle'), count: id('files-count'), resize: id('files-resize'),
           status: id('files-status') };
}

function _filesEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function _filesBtn(label, onClick, title, cls) {
  const b = _filesEl('button', 'btn btn-sm' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function _filesStatus(msg, tone) {
  const { status } = _filesEls();
  if (!status) return;
  status.textContent = msg || '';
  if (tone) status.dataset.tone = tone; else delete status.dataset.tone;
}

function _filesSavePrefs() {
  try { localStorage.setItem(FILES_PREFS_KEY, JSON.stringify({ open: _fp.open, width: _fp.width })); } catch (e) {}
}

function _filesLoadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(FILES_PREFS_KEY) || '{}');
    if (typeof p.width === 'number' && isFinite(p.width)) _fp.width = Math.max(FILES_WIDTH_MIN, Math.round(p.width));
    return p;
  } catch (e) { return {}; }
}

function _filesApplyWidth() {
  const max = Math.max(FILES_WIDTH_MIN, Math.floor(window.innerWidth * 0.7));
  const w = Math.min(max, Math.max(FILES_WIDTH_MIN, _fp.width));
  document.documentElement.style.setProperty('--files-w', w + 'px');
}

function filesPanelIsOpen() { return _fp.open; }

/**
 * The header button is there only when it has something to do: the chat on
 * screen has at least one file, or the panel is open. The home screen has no
 * chat, so no button. An open panel keeps it, so moving to a chat with no
 * files never takes away the button the panel was opened from; closing the
 * panel there hides it. _fp.files is the active chat's list, kept current by
 * filesPanelSync.
 */
function _filesShowToggle(els) {
  if (els && els.toggle) els.toggle.hidden = !(_fp.open || _fp.files.length > 0);
}

/** Open or close the panel; with no argument, switch it. */
function toggleFilesPanel(force) {
  const els = _filesEls();
  if (!els.panel) return;
  _fp.open = force === undefined ? !_fp.open : !!force;
  els.panel.hidden = !_fp.open;
  document.body.classList.toggle('files-open', _fp.open);
  if (els.toggle) els.toggle.setAttribute('aria-expanded', _fp.open ? 'true' : 'false');
  _filesShowToggle(els);
  _filesSavePrefs();
  if (_fp.open) { _filesApplyWidth(); filesPanelSync(true); }
}

function closeFilesPanel() { toggleFilesPanel(false); }

/** Show one file, at one version (null: the latest). Opens the panel. */
function openFileInPanel(key, version) {
  _fp.key = key;
  _fp.version = (typeof version === 'number') ? version : null;
  _fp.tab = null;
  _fp.editing = false;
  if (!_fp.open) toggleFilesPanel(true); else filesPanelSync(true);
}

function _filesShowList() {
  _fp.key = null; _fp.version = null; _fp.tab = null; _fp.editing = false;
  filesPanelSync(true);
}

/**
 * Bring the panel up to date with the active conversation: the header
 * button and its count always, the panel itself when it is open. Called after the
 * chat renders (renderMessages), while a reply streams (throttled), and by
 * the panel's own controls with force.
 */
function filesPanelSync(force) {
  const els = _filesEls();
  if (!els.panel) return;
  const thread = (typeof getActiveThread === 'function') ? getActiveThread() : null;
  if (!thread || (thread.id !== _fp.threadId)) {
    // Another conversation: its own files, from the list.
    if (_fp.threadId !== (thread ? thread.id : null)) { _fp.key = null; _fp.version = null; _fp.editing = false; }
    _fp.threadId = thread ? thread.id : null;
  }
  const sig = _filesSig(thread);
  const changed = sig !== _fp.sig;
  if (changed) { _fp.files = scanConversationFiles(thread); _fp.sig = sig; }
  if (els.count) {
    const n = _fp.files.length;
    els.count.textContent = n ? String(n) : '';
    if (els.toggle) els.toggle.title = n ? 'Files in this chat (' + n + ')' : 'Files in this chat';
  }
  _filesShowToggle(els);
  if (!_fp.open || (!changed && !force)) return;
  // Mid-edit, a new token elsewhere must not throw away what is being typed.
  if (_fp.editing && !force) return;
  renderFilesPanel();
}

function renderFilesPanel() {
  const els = _filesEls();
  if (!els.body) return;
  const file = _fp.key ? _filesCurrent() : null;
  if (_fp.key && !file) { _fp.key = null; _fp.editing = false; }
  // Keep the reader's place when the same file redraws.
  const keepScroll = file && els.body.dataset.key === file.key ? els.body.scrollTop : 0;
  els.body.textContent = '';
  els.body.dataset.key = file ? file.key : '';
  if (els.back) els.back.hidden = !file;
  if (els.title) els.title.textContent = file ? file.name : 'Files';
  if (!file) { _filesRenderList(els.body); return; }
  _filesRenderFile(els.body, file);
  if (keepScroll) els.body.scrollTop = keepScroll;
}

function _filesIcon(type) {
  return { markdown: '\u{1F4DD}', html: '\u{1F310}', svg: '\u{1F5BC}️', csv: '\u{1F4CA}', tsv: '\u{1F4CA}' }[type.kind] || '\u{1F4C4}';
}

function _filesRenderList(body) {
  const files = _fp.files;
  if (!files.length) {
    const empty = _filesEl('div', 'files-empty');
    empty.appendChild(_filesEl('p', null, 'No files in this chat yet.'));
    empty.appendChild(_filesEl('p', null, 'When a character writes a file (a ```file:name block) it shows up here, whole, with every version. So do text files you attach, and web pages or pictures written as html or svg code.'));
    body.appendChild(empty);
    return;
  }
  const list = _filesEl('div', 'files-list');
  for (const f of files) {
    const v = f.versions[f.versions.length - 1];
    const row = _filesEl('button', 'files-row');
    row.type = 'button';
    row.dataset.key = f.key;
    row.appendChild(_filesEl('span', 'files-row-icon', _filesIcon(f.type)));
    const txt = _filesEl('span', 'files-row-text');
    txt.appendChild(_filesEl('span', 'files-row-name', f.name));
    const bits = [];
    if (f.versions.length > 1) bits.push(f.versions.length + ' versions');
    bits.push(v.source === 'attachment' ? 'attached by you' : v.author);
    if (!v.closed) bits.push('being written…');
    txt.appendChild(_filesEl('span', 'files-row-meta', bits.join(' · ')));
    row.appendChild(txt);
    row.addEventListener('click', () => openFileInPanel(f.key));
    list.appendChild(row);
  }
  body.appendChild(list);
}

function _filesRenderFile(body, file) {
  const vi = _filesVersionIndex(file);
  const v = file.versions[vi];
  const type = file.type;
  const tab = _fp.tab || (type.preview ? 'preview' : 'code');

  // Versions.
  const bar = _filesEl('div', 'files-bar');
  if (file.versions.length > 1) {
    const nav = _filesEl('div', 'files-versions');
    const prev = _filesBtn('‹', () => { _fp.version = vi - 1; _fp.editing = false; renderFilesPanel(); }, 'Earlier version', 'files-ver-btn');
    prev.disabled = vi === 0;
    prev.setAttribute('aria-label', 'Earlier version');
    const next = _filesBtn('›', () => { _fp.version = vi + 1 >= file.versions.length - 1 ? null : vi + 1; _fp.editing = false; renderFilesPanel(); }, 'Later version', 'files-ver-btn');
    next.disabled = vi === file.versions.length - 1;
    next.setAttribute('aria-label', 'Later version');
    nav.appendChild(prev);
    nav.appendChild(_filesEl('span', 'files-ver-label',
      'v' + (vi + 1) + ' of ' + file.versions.length + (vi === file.versions.length - 1 ? ' (latest)' : '')));
    nav.appendChild(next);
    bar.appendChild(nav);
  }
  bar.appendChild(_filesEl('span', 'files-who', v.source === 'attachment' ? 'attached by you' : 'by ' + v.author));

  // Preview / code.
  if (type.preview && !_fp.editing) {
    const tabs = _filesEl('div', 'files-tabs');
    tabs.setAttribute('role', 'tablist');
    for (const [id, label] of [['preview', 'PREVIEW'], ['code', 'CODE']]) {
      const t = _filesBtn(label, () => { _fp.tab = id; renderFilesPanel(); }, null, 'files-tab' + (tab === id ? ' active' : ''));
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', tab === id ? 'true' : 'false');
      tabs.appendChild(t);
    }
    bar.appendChild(tabs);
  }
  body.appendChild(bar);

  if (!v.closed) body.appendChild(_filesEl('div', 'files-note', 'Being written… it updates as it arrives.'));
  if (v.truncated) body.appendChild(_filesEl('div', 'files-note', 'Only the start of this attachment was sent, so only that is here.'));

  // Actions.
  const acts = _filesEl('div', 'files-actions');
  if (_fp.editing) {
    acts.appendChild(_filesBtn('USE IN MY NEXT MESSAGE', () => filesAttachVersion(file, _fp.editText, true),
      'Attach this text to your next message as ' + file.name + ', so the character reads it', 'btn-fill'));
    acts.appendChild(_filesBtn('ASK ABOUT THE SELECTION', () => filesAskAboutSelection(file),
      'Attach the file and quote the part you selected into the message box'));
    acts.appendChild(_filesBtn('CANCEL', () => { _fp.editing = false; _filesStatus(''); renderFilesPanel(); }));
  } else {
    acts.appendChild(_filesBtn('COPY', (e) => _filesCopy(v.content, e.currentTarget), 'Copy this version'));
    acts.appendChild(_filesBtn('SAVE', () => filesDownload(file.name, v.content), 'Download this version as ' + file.name));
    acts.appendChild(_filesBtn('EDIT', () => { _fp.editing = true; _fp.editText = v.content; renderFilesPanel(); },
      'Edit it here, then hand your version to the character'));
    acts.appendChild(_filesBtn('ASK ABOUT THE SELECTION', () => filesAskAboutSelection(file),
      'Select part of the file, then press this: it attaches the file and quotes that part into the message box'));
    acts.appendChild(_filesBtn('SHOW IN CHAT', () => filesShowInChat(v), 'Scroll the chat to where this version is'));
    if (/^(md|markdown|txt)$/.test(type.ext) && typeof saveTextToCardMemory === 'function') {
      acts.appendChild(_filesBtn('SAVE TO MEMORY', () => saveTextToCardMemory(file.name, v.content, v.msgIndex),
        "Keep this version in the character's memory"));
    }
    const live = (type.kind === 'html' || type.kind === 'svg') && tab === 'preview';
    if (live) {
      const runKey = file.key + '|' + vi;
      const running = _fp.run.has(runKey) || filesRunScriptsAlways();
      if (!running) {
        acts.appendChild(_filesBtn('RUN SCRIPTS', () => { _fp.run.add(runKey); renderFilesPanel(); },
          "Let this page's scripts run, still cut off from the internet and from GobboNet"));
      }
      acts.appendChild(_filesBtn('FULL SCREEN', () => {
        const fr = body.querySelector('.files-frame');
        if (fr && fr.requestFullscreen) fr.requestFullscreen().catch(() => {});
      }, 'Show the preview on the whole screen'));
    }
  }
  body.appendChild(acts);

  // The file.
  const view = _filesEl('div', 'files-view');
  if (_fp.editing) {
    const ta = _filesEl('textarea', 'files-edit');
    ta.value = _fp.editText;
    ta.spellcheck = false;
    ta.setAttribute('aria-label', 'Edit ' + file.name);
    ta.addEventListener('input', () => { _fp.editText = ta.value; });
    view.appendChild(ta);
    body.appendChild(view);
    body.appendChild(_filesEl('div', 'files-note',
      'Your version goes to the character with your next message, as ' + file.name + '; when you send it, it becomes the next version here.'));
    setTimeout(() => { try { ta.focus(); } catch (e) {} }, 0);
    return;
  }
  if (tab === 'preview' && type.kind === 'markdown') {
    const md = _filesEl('div', 'files-md message-content');
    md.innerHTML = parseMarkdown(v.content || '');
    view.appendChild(md);
  } else if (tab === 'preview' && (type.kind === 'csv' || type.kind === 'tsv')) {
    view.appendChild(_filesTable(v.content, type.kind === 'csv' ? ',' : '\t'));
  } else if (tab === 'preview' && (type.kind === 'html' || type.kind === 'svg')) {
    if (!v.closed) {
      view.appendChild(_filesEl('div', 'files-note', 'The preview appears when the file is finished.'));
    } else {
      const runKey = file.key + '|' + vi;
      const scripts = _fp.run.has(runKey) || filesRunScriptsAlways();
      const holder = _filesEl('div', 'files-frame-wrap');
      holder.appendChild(_filesFrame(v.content, type.kind, scripts, () => {
        holder.textContent = '';
        holder.appendChild(_filesEl('div', 'files-note files-stopped',
          'This page tried to open another address, so the preview was stopped. Previews stay inside GobboNet; copy the file to open it elsewhere.'));
      }));
      view.appendChild(holder);
      view.appendChild(_filesEl('div', 'files-note', scripts
        ? 'Scripts are running. The page cannot reach the internet or GobboNet.'
        : 'Scripts are off, so buttons and animations may not work: RUN SCRIPTS turns them on. The page cannot reach the internet or GobboNet.'));
    }
  } else {
    const pre = _filesEl('pre', 'files-code');
    const code = document.createElement('code');
    code.innerHTML = (typeof highlightCode === 'function') ? highlightCode(v.content || '', type.lang) : '';
    if (typeof highlightCode !== 'function') code.textContent = v.content || '';
    pre.appendChild(code);
    view.appendChild(pre);
  }
  body.appendChild(view);
}

/* ---- What the buttons do --------------------------------------------------- */

function filesRunScriptsAlways() {
  try { return !!(state && state.settings && state.settings.filesRunScripts === true); } catch (e) { return false; }
}

function filesDownload(name, text) {
  const blob = new Blob([text || ''], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'file.txt';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function _filesCopy(text, btn) {
  const done = ok => {
    if (!btn) return;
    const was = btn.textContent;
    btn.textContent = ok ? 'COPIED' : 'FAILED';
    setTimeout(() => { btn.textContent = was; }, 1200);
  };
  const fallback = () => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text || '';
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch (e) { done(false); }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text || '').then(() => done(true)).catch(fallback);
  else fallback();
}

/**
 * Attach text to the next message as `file.name`, replacing an attachment of
 * that name not yet sent. The character reads it with the message, and once
 * sent it is the file's next version here.
 */
function filesAttachVersion(file, text, leaveEdit) {
  if (typeof _pendingAttachments === 'undefined') return false;
  const name = file.name;
  let body = String(text || '');
  let truncated = false;
  if (typeof ATTACH_TEXT_LIMIT === 'number' && body.length > ATTACH_TEXT_LIMIT) { body = body.slice(0, ATTACH_TEXT_LIMIT); truncated = true; }
  _pendingAttachments = _pendingAttachments.filter(a => !(a.kind === 'text' && a.name.toLowerCase() === name.toLowerCase()));
  _pendingAttachments.push({ id: generateId(), name, kind: 'text', size: new Blob([body]).size, text: body, truncated });
  if (typeof renderAttachTray === 'function') renderAttachTray();
  if (leaveEdit) { _fp.editing = false; renderFilesPanel(); }
  _filesStatus(name + ' is attached to your next message' + (truncated ? ' (only its start fits)' : '') + '.', 'ok');
  return true;
}

/* ASK ABOUT THE SELECTION: the selected part, quoted into the message box,
   with the whole file attached so the character can see it in place. */
function filesAskAboutSelection(file) {
  const els = _filesEls();
  let selected = '';
  let source = null;
  const ta = els.body && els.body.querySelector('.files-edit');
  if (ta && ta.selectionEnd > ta.selectionStart) {
    selected = ta.value.slice(ta.selectionStart, ta.selectionEnd);
    source = ta.value;
  } else {
    const sel = window.getSelection && window.getSelection();
    if (sel && sel.rangeCount && els.body && els.body.contains(sel.anchorNode)) selected = String(sel);
  }
  selected = selected.trim();
  if (!selected) { _filesStatus('Select part of the file first, in CODE or in EDIT.', 'err'); return; }
  const v = file.versions[_filesVersionIndex(file)];
  filesAttachVersion(file, source !== null ? source : v.content, false);
  const quoted = selected.slice(0, 2000).split('\n').map(l => '> ' + l).join('\n');
  const input = document.getElementById('msg-input');
  if (!input) return;
  const prefix = 'In ' + file.name + ', about this part:\n' + quoted + '\n\n';
  input.value = prefix + input.value;
  try {
    input.dispatchEvent(new Event('input'));
    input.focus();
    input.setSelectionRange(prefix.length, prefix.length);
  } catch (e) {}
  _filesStatus('Quoted into the message box, with ' + file.name + ' attached. Say what to change, then send.', 'ok');
}

/** SHOW IN CHAT: scroll to the message holding a version and light it up. */
function filesShowInChat(v) {
  const msgEl = document.querySelector('#messages .message[data-index="' + (v.msgIndex | 0) + '"]');
  if (!msgEl) { _filesStatus('That message is not on screen.', 'err'); return; }
  const target = (v.fence >= 0 && msgEl.querySelector('[data-fence="' + (v.fence | 0) + '"]')) || msgEl.querySelector('.msg-attachments') || msgEl;
  try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { target.scrollIntoView(); }
  target.classList.add('files-flash');
  setTimeout(() => target.classList.remove('files-flash'), 1600);
  if (window.innerWidth < FILES_OVERLAY_BELOW) closeFilesPanel();
}

/** The Open button on a file block or a previewable code block in the chat. */
function openFileFromBlock(btn) {
  const block = btn && btn.closest && btn.closest('[data-fence]');
  const msgEl = btn && btn.closest && btn.closest('[data-index]');
  if (!block || !msgEl) return;
  const mi = Number(msgEl.dataset.index), fi = Number(block.dataset.fence);
  const thread = getActiveThread();
  _fp.sig = '';   // scan now, in case this is a block that just finished
  _fp.files = scanConversationFiles(thread);
  _fp.sig = _filesSig(thread);
  _fp.threadId = thread ? thread.id : null;
  for (const f of _fp.files) {
    const vi = f.versions.findIndex(v => v.msgIndex === mi && v.fence === fi);
    if (vi >= 0) { openFileInPanel(f.key, vi === f.versions.length - 1 ? null : vi); return; }
  }
}

/**
 * After a reply has finished: if it wrote a file, open the panel on it --
 * when CONFIG says to (the default), on a screen wide enough to keep the
 * chat beside it, and not over a file being edited.
 */
function filesPanelAfterReply(thread, msg) {
  try {
    if (!thread || !msg || typeof msg.content !== 'string' || msg.content.indexOf('file:') < 0) return;
    const s = (state && state.settings) || {};
    if (s.filesAutoOpen === false || window.innerWidth < FILES_AUTO_OPEN_FROM) return;
    if (thread.id !== state.activeThreadId || (_fp.open && _fp.editing)) return;
    const mi = thread.messages.indexOf(msg);
    if (mi < 0) return;
    _fp.files = scanConversationFiles(thread);
    _fp.sig = _filesSig(thread);
    _fp.threadId = thread.id;
    const wrote = _fp.files.filter(f => f.key.startsWith('f:') && f.versions.some(v => v.msgIndex === mi && v.source === 'block'));
    if (!wrote.length) return;
    openFileInPanel(wrote[0].key);
  } catch (e) { console.error('[files]', e); }
}

/* While a reply streams, keep an open panel current, a few times a second. */
function filesPanelStreamTick() {
  if (!_fp.open || _fp.streamTimer) return;
  _fp.streamTimer = setTimeout(() => { _fp.streamTimer = null; filesPanelSync(false); }, 400);
}

/* ---- Wiring ------------------------------------------------------------------ */

function _filesWire() {
  const els = _filesEls();
  if (!els.panel || els.panel.dataset.wired) return;
  els.panel.dataset.wired = '1';
  if (els.toggle) els.toggle.addEventListener('click', () => toggleFilesPanel());
  if (els.close) els.close.addEventListener('click', closeFilesPanel);
  if (els.back) els.back.addEventListener('click', _filesShowList);
  els.panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !_fp.editing) {
      e.stopPropagation(); closeFilesPanel();
      // Back to the button, unless closing hid it (a chat with no files).
      const back = (els.toggle && !els.toggle.hidden) ? els.toggle : document.getElementById('msg-input');
      try { back && back.focus(); } catch (_) {}
    }
  });
  // Resizing: drag the left edge, or focus it and use the arrow keys.
  const r = els.resize;
  if (r) {
    const set = (w) => { _fp.width = Math.max(FILES_WIDTH_MIN, Math.round(w)); _filesApplyWidth(); };
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      document.body.classList.add('files-resizing');
      const move = (ev) => set(window.innerWidth - ev.clientX);
      const up = () => {
        r.removeEventListener('pointermove', move);
        r.removeEventListener('pointerup', up);
        r.removeEventListener('pointercancel', up);
        document.body.classList.remove('files-resizing');
        _filesSavePrefs();
      };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up);
      r.addEventListener('pointercancel', up);
    });
    r.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { set(_fp.width + 24); _filesSavePrefs(); e.preventDefault(); }
      if (e.key === 'ArrowRight') { set(_fp.width - 24); _filesSavePrefs(); e.preventDefault(); }
    });
    r.addEventListener('dblclick', () => { set(FILES_WIDTH_DEFAULT); _filesSavePrefs(); });
  }
  window.addEventListener('resize', () => { if (_fp.open) _filesApplyWidth(); });
  // Opened last time on a wide screen: open again.
  const p = _filesLoadPrefs();
  _filesApplyWidth();
  if (p.open && window.innerWidth >= FILES_OVERLAY_BELOW) toggleFilesPanel(true);
  // chat.html starts the button hidden; say so here too, so the page and this
  // module agree before the first render.
  _filesShowToggle(els);
}

try { _filesWire(); } catch (e) { console.error('[files] wiring:', e); }
