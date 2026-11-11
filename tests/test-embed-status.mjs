/**
 * 1.8.0 (#15): the page says whether the RAG Storybook can match by meaning.
 * GobboNet starts the embedding server itself now, and /health-fileserver
 * reports it under "embed" (running, starting, restarting, standby, failed,
 * external, off) with "embed_detail" saying why when it is not on. Privacy
 * Status and the line under the storybook show it.
 *
 * Run for real: refreshEmbedState and embedStateText (js/08-rag.js),
 * loadPrivacyEmbedLine (js/15-cards.js) and updateStorybookReadout
 * (js/07-prompt.js), against a fake DOM and a fake /health-fileserver.
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
const RAG = slice(read('js/08-rag.js'), 'let _embedHealth', '/* ---- Embedding client');
const CARDS = slice(read('js/15-cards.js'), '/** Privacy Status\'s line', 'async function loadStandDownPanel');
const PROMPT = slice(read('js/07-prompt.js'), 'function updateStorybookReadout', 'function renderAvatar');

let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); } };

function page({ health, served = true, storybook = '# Selah, [1.0 angel]\nAn angel.' } = {}) {
  const els = {};
  const el = id => (els[id] = els[id] || { id, textContent: '', value: '', style: {}, classList: { s: new Set(), toggle(c, on) { on ? this.s.add(c) : this.s.delete(c); }, contains(c) { return this.s.has(c); } } });
  el('card-rag-storybook').value = storybook;
  const calls = [];
  const ctx = {
    IS_SERVED: served, console,
    window: { location: { origin: 'http://127.0.0.1:9066' } },
    document: { getElementById: id => el(id) },
    fetch: async (url) => { calls.push(url); return { ok: true, json: async () => health }; },
    parseStorybook: () => ({ counts: {}, order: ['Selah'], entities: { Selah: { tags: [1] } } }),
  };
  vm.createContext(ctx);
  vm.runInContext(RAG + CARDS + PROMPT + ';this._eh = () => _embedHealth;', ctx);
  return { ctx, els, calls, el };
}

console.log('\n=== each state, in words ===');
{
  const t = page().ctx.embedStateText;
  ok(t({ state: 'running' }).on && /is on: the embedding server is running on this PC/.test(t({ state: 'running' }).text), 'running: on, and local');
  ok(/restarting it\. the embedding server stopped unexpectedly\./i.test(t({ state: 'restarting', detail: 'the embedding server stopped unexpectedly' }).text),
     'restarting: says GobboNet is restarting it, and why', t({ state: 'restarting', detail: 'the embedding server stopped unexpectedly' }).text);
  ok(/resting with the chat model and comes back with your next message/.test(t({ state: 'standby' }).text), 'standby: rests with the chat model');
  const failed = t({ state: 'failed', detail: 'no embedding model at /x/nomic.gguf. Semantic search stays off until it is there' });
  ok(!failed.on && /Matching by meaning is off\. No embedding model at \/x\/nomic\.gguf\. Semantic search stays off until it is there\. Names and tags still match\./.test(failed.text),
     'failed: off, with the reason, and that names and tags still work', failed.text);
  ok(/embed_mode = "off" in config\.toml/.test(t({ state: 'off' }).text), 'off: names the setting');
  ok(t({ state: 'external' }).on && /does not run, at embed_url/.test(t({ state: 'external' }).text), 'external: on, and whose');
  ok(t({}).text === '' && t({ state: '' }).short === '', 'an older server that does not say: nothing is said');
}

console.log('\n=== Privacy Status ===');
{
  const p = page({ health: { status: 'ok', embed: 'failed', embed_detail: 'nomic.gguf does not match its pinned SHA-256' } });
  await p.ctx.loadPrivacyEmbedLine();
  const line = p.els['privacy-embed'];
  ok(/does not match its pinned SHA-256/.test(line.textContent) && line.style.display === '' && line.classList.contains('privacy-embed-off'),
     'a failed server is shown, with its reason, in the dimmer colour', line.textContent);
  ok(p.calls[0] === 'http://127.0.0.1:9066/health-fileserver', 'from /health-fileserver');
}
{
  const p = page({ health: { status: 'ok', embed: 'running' } });
  await p.ctx.loadPrivacyEmbedLine();
  ok(/running on this PC/.test(p.els['privacy-embed'].textContent) && !p.els['privacy-embed'].classList.contains('privacy-embed-off'), 'a running one, in the box\'s green');
}
{
  const p = page({ health: { status: 'ok', server: 'gobbonet', version: '1.7.9' } });
  await p.ctx.loadPrivacyEmbedLine();
  ok(p.els['privacy-embed'].style.display === 'none', 'an older server: the line stays hidden');
}
{
  const p = page({ served: false });
  await p.ctx.loadPrivacyEmbedLine();
  ok(p.calls.length === 0 && /Opened from a file/.test(p.els['privacy-embed'].textContent), 'file://: asks nothing, and says why');
}

console.log('\n=== under the RAG Storybook ===');
{
  const p = page({ health: { embed: 'running' } });
  p.ctx.updateStorybookReadout();
  ok(!/by meaning/.test(p.els['storybook-readout'].textContent), 'before the server has been asked, the readout is as it was');
  await p.ctx.refreshEmbedState();
  p.ctx.updateStorybookReadout();
  ok(/read as → 1 named entry: Selah \(1 tag\) · by meaning: on$/.test(p.els['storybook-readout'].textContent), 'running: "by meaning: on"', p.els['storybook-readout'].textContent);
}
{
  const p = page({ health: { embed: 'standby' } });
  await p.ctx.refreshEmbedState();
  p.ctx.updateStorybookReadout();
  ok(/· by meaning: resting$/.test(p.els['storybook-readout'].textContent), 'standby: "resting"');
  p.ctx._embedHealth = undefined;
}
{
  const p = page({ health: { embed: 'failed', embed_detail: 'x' } });
  await p.ctx.refreshEmbedState();
  p.ctx.updateStorybookReadout();
  ok(/by meaning: off \(see CONFIG > Privacy Status\)$/.test(p.els['storybook-readout'].textContent), 'failed: off, and where the reason is');
}

console.log('\n=== the wiring ===');
{
  const cards = read('js/15-cards.js');
  ok(/loadLanPanel\(\);\n  loadPrivacyEmbedLine\(\);/.test(cards), 'opening CONFIG fills the line');
  ok(/updateStorybookReadout\(\);\n  \/\/ The readout says whether matching by meaning is on; ask, then redraw it\.\n  refreshEmbedState\(\)\.then\(updateStorybookReadout\)/.test(cards), 'opening the card editor asks, then redraws the readout');
  const html = read('chat.html');
  ok(/id="privacy-embed" role="status" aria-live="polite"/.test(html) && html.indexOf('id="privacy-embed"') > html.indexOf('Privacy Status</label>'), 'the line is in Privacy Status, announced when it changes');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
