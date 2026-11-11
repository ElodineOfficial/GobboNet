/**
 * 1.7.9 F3 — CONFIG grouped into sections, with search.
 *
 * The promise was "nothing removed or renamed, only moved". This holds it:
 * every element id and every label CONFIG had in 1.7.8 is still there,
 * exactly once, inside CONFIG. The sections, the order, Advanced starting
 * closed, Privacy Status staying last, and the search wiring are checked too.
 *
 * The behaviour itself (filtering, Advanced opening for a match, Esc) needs
 * a real DOM; tests/console/1.7.9-step-10.js runs it in the browser.
 */
import fs from 'fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const CARDS = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
const CSS = fs.readFileSync(ROOT + '/css/18-config-sections.css', 'utf8');

let pass = 0, fail = 0;
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label + (extra !== undefined ? '\n      ' + String(extra).slice(0, 600) : '')); }
};

const a = HTML.indexOf('id="settings-modal"');
const b = HTML.indexOf('<div class="modal-actions">', a);
const CONFIG = HTML.slice(a, b);

// Every element id inside CONFIG in 1.7.8 (71), and every <label> text (28).
const IDS_178 = ["settings-modal", "tip-avatar-size", "set-avatar-scale", "avatar-scale-val", "tip-reply-delivery", "set-stream-replies", "tip-auto-scroll", "tip-auto-continue", "set-auto-continue-delay", "set-auto-continue-max", "tip-sticky-cards", "set-sticky-cards", "tip-personas-moved", "set-apikey", "search-test-status", "search-test-output", "tip-search-key", "prompt-order-group", "tip-prompt-order", "set-retrieval-near-end", "tip-prompt-order-switch", "tip-performance", "perf-ctx", "perf-gpu", "tip-gpu-layers", "perf-kv", "perf-status", "lan-group", "tip-phone", "lan-addr-list", "lan-addr-note", "tip-lan-addresses", "lan-host", "lan-port", "lan-preview", "lan-save", "lan-status", "network-hosts-group", "tip-network-hosts", "set-network-hosts", "tip-network-hosts-scope", "network-hosts-save", "network-hosts-status", "config-file-group", "tip-config-file", "config-file-path", "config-file-open", "config-file-editor", "config-file-text", "config-file-notes", "config-file-save", "config-file-reload", "config-file-undo", "config-file-status", "tip-remote-images", "set-allow-remote-images", "tip-cot-timeout", "set-cot-timeout-enabled", "cot-timeout-timer-wrap", "set-cot-timeout-minutes", "tip-lore-timeout", "set-lore-timeout", "add-model-block", "add-model-unavailable", "standdown-group", "tip-standdown", "standdown-row", "set-standdown-minutes", "standdown-apply", "standdown-status", "tip-privacy"];
const LABELS_178 = ["Avatar Size", "Reply Delivery", "Stream replies as they're written", "Follow, but let go  stops as soon as you scroll up or touch the messages (default)", "Always follow  stays glued to the newest text. You won't be able to read back until the reply finishes.", "Don't follow  the view never moves on its own. Use the jump button to catch up.", "Auto-Continue", "Character Editor", "Sticky character editor", "Search API Key (web search)", "Prompt Order  less work per message", "Put lorebook snippets just before my newest message", "Performance  llama.cpp tuning", "Context size (tokens)", "GPU layers", "KV cache type", "Phone  Other Devices", "Answer on", "Port", "Network access  custom hostnames", "Config File  config.toml", "Remote Images In Cards", "Allow remote images", "Infinite Runtime Bug Fix", "Enable auto-cull", "Lore Compression", "Add a Model", "Idle Stand-Down", "Privacy Status"];

console.log('\n=== A. nothing lost, nothing doubled ===');
{
  const ids = [...CONFIG.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  const missing = IDS_178.filter(id => !ids.includes(id));
  ok(missing.length === 0, `all ${IDS_178.length} ids from 1.7.8 are still in CONFIG`, missing);
  const twice = IDS_178.filter(id => ids.filter(x => x === id).length !== 1);
  ok(twice.length === 0, 'each exactly once', twice);
  // Added on purpose since 1.7.9: When GobboNet Starts (1.8.0, PR #58).
  // And Model Folders (1.8.0, issue #68).
  const IDS_180 = ['open-browser-group', 'tip-open-browser', 'set-open-browser', 'open-browser-status',
    'model-folders-group', 'tip-model-folders', 'model-folders-fields', 'set-model-dir', 'set-model-dirs',
    'set-scan-hf-cache', 'model-folders-save', 'model-folders-status',
    // And Card Tools (1.8.0, roadmap #9).
    'card-tools-group', 'tip-card-tools-limits', 'set-tool-max-rounds', 'set-tool-timeout', 'set-tool-result-max', 'set-tool-args-max',
    // And Model Switching (1.8.0, roadmap #10).
    'model-follow-group', 'tip-model-follow',
    // And the GPU menu in Performance (1.8.0, roadmap #12).
    'perf-device-group', 'perf-device', 'perf-device-hint', 'tip-perf-device', 'perf-device-note', 'perf-prime-row', 'perf-prime',
    // And Privacy Status's embedding server line (1.8.0, roadmap #15).
    'privacy-embed',
    // And MCP Servers in Advanced (1.8.0, roadmap #16).
    'mcp-group', 'tip-mcp', 'mcp-note', 'mcp-list', 'mcp-add', 'mcp-form', 'mcp-f-json', 'mcp-f-json-fill', 'mcp-f-name',
    'mcp-f-command', 'mcp-f-args', 'mcp-f-env', 'mcp-f-enabled', 'mcp-f-save', 'mcp-f-cancel', 'mcp-status',
    'mcp-f-paste', 'mcp-paste',
    // And the Files Panel box (1.8.0).
    'files-panel-group', 'tip-files-panel', 'set-files-auto-open', 'set-files-fold', 'set-files-run-scripts'];
  ok(IDS_180.every(id => ids.filter(x => x === id).length === 1), `the ${IDS_180.length} ids added in 1.8.0 are there, once each`, IDS_180.filter(id => !ids.includes(id)));
  const extra = ids.filter(id => !IDS_178.includes(id) && !IDS_180.includes(id));
  ok(extra.every(id => id.startsWith('cfg-')), 'the only other new ids are cfg-* (sections, search, the tour box)', extra);
  const labels = [...CONFIG.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)]
    .map(m => m[1].replace(/&[#\w]+;|<[^>]+>/g, '').trim());
  const lost = LABELS_178.filter(l => !labels.includes(l));
  ok(lost.length === 0, `all ${LABELS_178.length} labels are unchanged: nothing renamed`, lost);
  // Added on purpose since 1.7.8, and nothing else: the tour's replay box (step 11).
  const ADDED_179 = ['Tour'];
  ok(ADDED_179.every(l => labels.includes(l)), 'the 1.7.9 additions are there: ' + ADDED_179.join(', '));
  const ADDED_180 = ['When GobboNet Starts', 'Open the browser when GobboNet starts',
    'Model Folders', 'Models folder', 'Extra folders to look in, one per line', 'Also look in the HuggingFace cache', 'Card Tools',
    'Model Switching', 'Ask first  a one-line bar offers the switch (default)',
    'Switch automatically  when nothing else is being written', "Don't switch  the loaded model answers every chat",
    'GPU', 'Use the NVIDIA GPU through PRIME offload',
    'MCP Servers  tools from other programs', 'Name', 'Program', 'Arguments, one per line',
    'Environment variables, one NAME=value per line', 'Switched on',
    'Files Panel', 'Open the panel when a reply writes a file (on a wide screen)',
    'Fold long files in the chat (the panel shows them whole)', 'Run scripts in previews without asking'];
  ok(ADDED_180.every(l => labels.includes(l)), 'the 1.8.0 additions are there: ' + ADDED_180.join(', '));
  ok(labels.length === LABELS_178.length + ADDED_179.length + ADDED_180.length, 'and no other label was added or doubled', labels.length);
}

console.log('\n=== B. the sections ===');
const SECTIONS = [
  ['basics', 'Basics'], ['chat', 'Characters &amp; Chat'], ['model', 'Model &amp; Performance'],
  ['network', 'Devices &amp; Network'], ['advanced', 'Advanced'],
];
{
  let last = -1;
  for (const [id, title] of SECTIONS) {
    const at = CONFIG.indexOf(`data-cfg-section="${id}"`);
    ok(at > last, `${title.replace('&amp;', '&')} is there, in order`);
    ok(CONFIG.includes(`id="cfg-h-${id}">${title}<span class="cfg-section-blurb">`), '  with its heading and one-line description');
    last = at;
  }
  ok(/<details class="cfg-section cfg-advanced" id="cfg-advanced" data-cfg-section="advanced">/.test(CONFIG),
     'Advanced is a <details>, and starts closed (no open attribute)');
  const where = (marker) => {
    const at = CONFIG.indexOf(marker);
    for (const [id] of [...SECTIONS].reverse()) if (CONFIG.lastIndexOf(`data-cfg-section="${id}"`, at) !== -1) return id;
    return null;
  };
  const PLACES = {
    basics: ['&#128100; Avatar Size', '&#128172; Reply Delivery', '&#127760; When GobboNet Starts', 'your persona card', '&#129517; Tour'],
    chat: ['&#9906; Character Editor', '&#8635; Auto-Continue', '&#128260; Model Switching', '&#128295; Card Tools', 'Search API Key (web search)', 'Remote Images In Cards'],
    model: ['&#128229; Add a Model', '&#128193; Model Folders', 'Performance &mdash; llama.cpp tuning', '&#128268; Idle Stand-Down', '&#9201; Infinite Runtime Bug Fix'],
    network: ['&#128241; Phone &amp; Other Devices', 'Network access &mdash; custom hostnames'],
    advanced: ['Prompt Order &mdash; less work per message', '&#128221; Lore Compression', 'Config File &mdash; config.toml'],
  };
  for (const [sec, markers] of Object.entries(PLACES)) {
    for (const m of markers) ok(where(m) === sec, `  ${m.replace(/&[#\w]+;/g, '').trim()} -> ${sec}`, where(m));
  }
  const privacy = CONFIG.indexOf('&#128274; Privacy Status');
  ok(privacy > CONFIG.lastIndexOf('</details>'), 'Privacy Status stays last, outside the sections, always shown');
}

console.log('\n=== C. search and memory ===');
{
  ok(/<input type="search" id="cfg-search"[^>]*aria-label="Find a setting"/.test(CONFIG), 'a labelled search box');
  ok(CONFIG.indexOf('id="cfg-search"') < CONFIG.indexOf('data-cfg-section="basics"'), 'at the top, above every section');
  ok(/id="cfg-search-empty" role="status" aria-live="polite"/.test(CONFIG), 'its result is announced');
  ok(/try \{ initConfigSections\(\); \}/.test(CARDS), 'openSettings sets it up, and a failure cannot stop CONFIG opening');
  ok(/localStorage\.setItem\(CFG_ADVANCED_KEY/.test(CARDS) && /try \{ open = localStorage\.getItem\(CFG_ADVANCED_KEY\) === '1'; \} catch/.test(CARDS),
     'Advanced remembers how it was left, and storage that throws is tolerated');
  ok(/_cfgAdvancedBeforeSearch !== null\) return;/.test(CARDS), 'opening Advanced by searching is not remembered as a choice');
  ok(/\.cfg-hide \{ display: none !important; \}/.test(CSS) && !/style\.display/.test(CARDS.slice(CARDS.indexOf('function filterConfig'), CARDS.indexOf('function filterConfig') + 2500)),
     'search hides with a class, never style.display, so it cannot fight panels that hide themselves');
  ok(HTML.includes('<link rel="stylesheet" href="css/18-config-sections.css">'), 'the stylesheet is linked');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
