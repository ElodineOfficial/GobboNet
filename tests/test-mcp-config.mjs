/**
 * 1.8.0 (#16): CONFIG > Advanced > MCP Servers.
 *
 * An MCP server is a program on the PC GobboNet runs on that gives characters
 * tools. The server decides who may add, change, switch on or switch off one
 * (internal/server/mcp.go, with Go tests); this checks the page reflects it:
 *
 *   - the box is in Advanced, says "Runs on this PC with your permissions" on
 *     every server, and offers only SWITCH OFF and CHECK TOOLS off the PC;
 *   - nothing from a server table or a program is put into the page as HTML;
 *   - the form turns lines into args and NAME=value into env, and a pasted
 *     "mcpServers" JSON block fills it without saving;
 *   - a Config File save of MCP settings is reported as applied now.
 *
 * Run for real: js/26-mcp.js against a fake DOM and a fake /mcp/servers.
 */
import fs from 'fs';
import vm from 'vm';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const read = f => fs.readFileSync(`${ROOT}/${f}`, 'utf8');
const HTML = read('chat.html');
const MCP = read('js/26-mcp.js');
const CARDS = read('js/15-cards.js');

let pass = 0, fail = 0;
const ok = (c, l, extra) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ ' + l + (extra !== undefined ? '\n      ' + JSON.stringify(extra) : '')); } };

// --- a fake DOM, just enough for 26-mcp.js -----------------------------------
class El {
  constructor(tag, id) {
    this.tagName = tag; this.id = id || ''; this.children = []; this.className = ''; this.dataset = {};
    this.style = {}; this.hidden = false; this.value = ''; this.checked = false; this.disabled = false;
    this._text = ''; this.listeners = {}; this.type = ''; this.parent = null; this.open = false;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set innerHTML(v) { throw new Error('innerHTML used: ' + v); }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  click() { (this.listeners.click || []).forEach(f => f()); }
  focus() {}
  setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = v; }
  closest() { return this.parent && this.parent.tagName === 'details' ? this.parent : null; }
  all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  buttons() { return this.all(c => c.tagName === 'button'); }
  button(label) { return this.buttons().find(b => b.textContent === label); }
}

function page({ servers, served = true, answer } = {}) {
  const els = {};
  const ids = ['mcp-group', 'mcp-note', 'mcp-list', 'mcp-add', 'mcp-form', 'mcp-f-name', 'mcp-f-command', 'mcp-f-args',
    'mcp-f-env', 'mcp-f-enabled', 'mcp-f-save', 'mcp-f-cancel', 'mcp-f-json', 'mcp-f-json-fill', 'mcp-f-paste', 'mcp-paste', 'mcp-status', 'settings-modal'];
  const buttons = ['mcp-add', 'mcp-f-save', 'mcp-f-cancel', 'mcp-f-json-fill', 'mcp-f-paste'];
  for (const id of ids) els[id] = new El(buttons.includes(id) ? 'button' : 'div', id);
  els['mcp-paste'].hidden = true;
  els['settings-modal'].classList = { contains: () => false };
  const calls = [];
  const ctx = {
    IS_SERVED: served, console, JSON, Object, Array, String, Number, setTimeout: () => 0, clearTimeout: () => {},
    confirm: () => true,
    window: { location: { origin: 'http://127.0.0.1:9066' } },
    document: { getElementById: id => els[id] || null, createElement: tag => new El(tag) },
    fetch: async (url, opts) => {
      calls.push({ url, opts });
      const body = answer ? answer(url, opts) : servers;
      return { ok: (body.status || 200) < 300, status: body.status || 200, json: async () => body };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(MCP, ctx);
  return { ctx, els, calls };
}

const FILES = { name: 'files', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/me/My Docs'],
  env: { TOKEN: 'abc' }, enabled: true, state: 'ready', tool_count: 2, server: { name: 'fs', version: '1.0' } };
const DB = { name: 'db', command: '/opt/db', args: [], env: {}, enabled: false, state: 'off', tool_count: 0 };
const EVIL = { name: 'x', command: '<img src=x onerror=alert(1)>', args: ['<b>'], env: {}, enabled: true, state: 'failed',
  detail: '<script>alert(1)</script>', retry_in_seconds: 4, tool_count: 0 };

console.log('\n=== the box ===');
{
  const box = HTML.slice(HTML.indexOf('id="mcp-group"') - 200, HTML.indexOf('id="mcp-status"'));
  const adv = HTML.slice(HTML.indexOf('id="cfg-advanced"'), HTML.indexOf('</details>', HTML.indexOf('id="config-file-group"')));
  ok(adv.includes('id="mcp-group"'), 'MCP Servers is in CONFIG > Advanced');
  ok(/Runs on this PC with your permissions/.test(box), 'the form says "Runs on this PC with your permissions"');
  const hint = /<div class="form-hint"[^>]*>([^<]*)<button type="button" class="tip-btn" aria-label="More about MCP servers"/.exec(box);
  ok(hint && hint[1].split(/[.!?](\s|$)/).filter(x => x && x.trim()).length === 1, 'the line before "?" is one sentence', hint && hint[1]);
  ok(!/\son[a-z]+="/.test(box), 'no inline handlers in the box: everything is wired in js/26-mcp.js');
  ok(/<script src="js\/25-tutorial\.js"><\/script>\n<script src="js\/26-mcp\.js"><\/script>/.test(HTML), 'js/26-mcp.js is loaded, after the tour');
  ok(/loadConfigFilePanel\(\);\n\s*loadMCPPanel\(\);/.test(CARDS), 'opening CONFIG loads it');
  ok(!/innerHTML/.test(MCP), 'js/26-mcp.js never uses innerHTML');
  ok(!/<details/.test(box), 'no <details> inside it: Advanced is one, and CONFIG search opens and closes those');
}

console.log('\n=== this PC ===');
{
  const p = page({ servers: { servers: [FILES, DB], can_manage: true, editable: true, max_servers: 32 } });
  await p.ctx.loadMCPPanel();
  const list = p.els['mcp-list'];
  const cards = list.children;
  ok(cards.length === 2 && cards[0].dataset.name === 'files' && cards[0].dataset.state === 'ready' && cards[1].dataset.state === 'off', 'one card per server, with its state');
  ok(cards.every(c => /Runs on this PC with your permissions\./.test(c.textContent)), 'every server says it runs on this PC with your permissions');
  ok(/npx -y @modelcontextprotocol\/server-filesystem "\/home\/me\/My Docs"/.test(cards[0].textContent), 'the command line, with a spaced argument quoted', cards[0].textContent);
  ok(/Running, 2 tools\./.test(cards[0].textContent) && /Environment: TOKEN/.test(cards[0].textContent) && !/abc/.test(cards[0].textContent),
     'running with its tool count; env by name, never its value on the card');
  ok(cards[0].button('SWITCH OFF') && cards[0].button('CHECK TOOLS') && cards[0].button('EDIT') && cards[0].button('REMOVE'), 'an enabled server: off, check, edit, remove');
  ok(cards[1].button('SWITCH ON') && !cards[1].button('SWITCH OFF'), 'a switched-off one can be switched on here');
  ok(p.els['mcp-add'].style.display === '', 'ADD SERVER is offered');

  cards[1].button('SWITCH ON').click();
  await new Promise(r => setTimeout(r, 0));
  const post = p.calls.find(c => c.opts && c.opts.method === 'POST');
  ok(post && post.url === 'http://127.0.0.1:9066/mcp/servers' && JSON.parse(post.opts.body).action === 'enable' && JSON.parse(post.opts.body).name === 'db',
     'SWITCH ON posts {action:"enable", name}', post && post.opts.body);
}

console.log('\n=== another device ===');
{
  const reason = 'MCP servers are added, changed and switched on from GobboNet on the PC it runs on (at http://localhost). From here you can switch one off.';
  const p = page({ servers: { servers: [Object.assign({}, FILES, { env: { TOKEN: '(hidden)' } }), DB], can_manage: false, editable: true, reason } });
  await p.ctx.loadMCPPanel();
  const cards = p.els['mcp-list'].children;
  ok(p.els['mcp-note'].textContent === reason, 'says where to go to manage them');
  ok(p.els['mcp-add'].style.display === 'none', 'no ADD SERVER');
  ok(cards[0].button('SWITCH OFF') && cards[0].button('CHECK TOOLS') && !cards[0].button('EDIT') && !cards[0].button('REMOVE'),
     'an enabled server: only SWITCH OFF and CHECK TOOLS');
  ok(cards[1].buttons().length === 0, 'a switched-off one cannot be switched on from here');
}

console.log('\n=== nothing from a table or a program is HTML ===');
{
  const p = page({ servers: { servers: [EVIL], can_manage: true, editable: true } });
  await p.ctx.loadMCPPanel();
  const card = p.els['mcp-list'].children[0];
  ok(card.textContent.includes('<img src=x onerror=alert(1)>') && card.textContent.includes('<script>alert(1)</script>'),
     'a hostile command and detail are shown as text (the fake DOM throws on innerHTML)');
  ok(/Not working \(tries again in 4 s\)\./.test(card.textContent), 'failed: says so, and when it tries again');
}

console.log('\n=== CHECK TOOLS ===');
{
  const tools = { servers: [Object.assign({}, FILES, { tools: [
    { name: 'read_file', description: 'Read a file. <b>bold</b>', read_only: true },
    { name: 'write_file', description: 'Write a file.', read_only: false }] })] };
  const p = page({ answer: (url) => url.includes('/mcp/tools') ? tools : { servers: [FILES], can_manage: true, editable: true } });
  await p.ctx.loadMCPPanel();
  await p.ctx.mcpCheckTools('files');
  ok(p.calls.some(c => c.url === 'http://127.0.0.1:9066/mcp/tools?refresh=1'), 'asks /mcp/tools?refresh=1');
  const card = p.els['mcp-list'].children[0];
  ok(/read_file/.test(card.textContent) && /says it only reads/.test(card.textContent) && /write_file/.test(card.textContent),
     'lists the tools, marking the ones that say they only read');
  ok(/files offers 2 tools\./.test(p.els['mcp-status'].textContent), 'and says how many', p.els['mcp-status'].textContent);
}

console.log('\n=== the form ===');
{
  const p = page({ servers: { servers: [FILES], can_manage: true, editable: true } });
  const c = p.ctx;
  ok(JSON.stringify(c.mcpArgsFromText('-y\r\n  @scope/pkg  \n\n/home/me/My Docs\n')) === JSON.stringify(['-y', '@scope/pkg', '/home/me/My Docs']),
     'arguments: one per line, ends trimmed, blank lines skipped');
  const env = c.mcpEnvFromText('TOKEN=a=b c\n# a comment\n\nOTHER=');
  ok(env.env && env.env.TOKEN === 'a=b c' && env.env.OTHER === '', 'env: NAME=value, the value kept whole', env);
  ok(/line 1/.test(c.mcpEnvFromText('no equals').error) && /not a variable name/.test(c.mcpEnvFromText('BAD-NAME=1').error), 'env: a bad line is named');

  await c.loadMCPPanel();
  c.openMCPForm('files');
  ok(p.els['mcp-form'].hidden === false && p.els['mcp-f-name'].value === 'files' && p.els['mcp-f-args'].value === '-y\n@modelcontextprotocol/server-filesystem\n/home/me/My Docs'
     && p.els['mcp-f-env'].value === 'TOKEN=abc' && p.els['mcp-f-enabled'].checked, 'EDIT fills the form from the server');
  p.els['mcp-f-name'].value = 'Files!';
  await c.saveMCPForm();
  ok(/lowercase letters/.test(p.els['mcp-status'].textContent) && !p.calls.some(x => x.opts && x.opts.method === 'POST'), 'a bad name is caught before anything is sent');
  p.els['mcp-f-name'].value = 'files2';
  await c.saveMCPForm();
  const post = p.calls.find(x => x.opts && x.opts.method === 'POST');
  const body = post && JSON.parse(post.opts.body);
  ok(body && body.action === 'save' && body.name === 'files' && body.server.name === 'files2' && body.server.args.length === 3 && body.server.env.TOKEN === 'abc' && body.server.enabled === true,
     'SAVE SERVER posts the table, and the name it replaces', body);
}

console.log('\n=== pasting a setup ===');
{
  const c = page({ servers: { servers: [] } }).ctx;
  const claude = c.parseMCPJson('{"mcpServers":{"Filesystem Server":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/Users/me/Desktop"],"env":{"A":"1","bad-name":"x"}}}}');
  ok(claude.server && claude.server.name === 'filesystem-server' && claude.server.command === 'npx' && claude.server.args.length === 3
     && claude.server.env.A === '1' && !('bad-name' in claude.server.env), 'the usual {"mcpServers": {...}} block', claude);
  ok(c.parseMCPJson('{"git":{"command":"uvx","args":["mcp-server-git"]}}').server.name === 'git', 'a bare {"name": {...}}');
  ok(c.parseMCPJson('{"command":"node","args":["server.js"]}').server.command === 'node', 'a bare {"command": ...}');
  ok(/on the internet/.test(c.parseMCPJson('{"mcpServers":{"remote":{"type":"http","url":"https://example.com/mcp"}}}').error), 'a remote server is said to be out of scope');
  ok(/not JSON/.test(c.parseMCPJson('npx -y thing').error), 'not JSON: says so');

  const p = page({ servers: { servers: [], can_manage: true, editable: true } });
  await p.ctx.loadMCPPanel();
  p.ctx.openMCPForm('');
  p.els['mcp-f-paste'].click();
  ok(p.els['mcp-paste'].hidden === false && p.els['mcp-f-paste'].attrs['aria-expanded'] === 'true', 'PASTE A SETUP opens the paste box');
  p.els['mcp-f-json'].value = '{"mcpServers":{"notes":{"command":"/opt/notes/mcp","args":["--stdio"],"env":{"KEY":"v"}}}}';
  p.els['mcp-f-json-fill'].click();
  ok(p.els['mcp-f-name'].value === 'notes' && p.els['mcp-f-command'].value === '/opt/notes/mcp' && p.els['mcp-f-args'].value === '--stdio' && p.els['mcp-f-env'].value === 'KEY=v',
     'FILL IN FROM THIS fills the form');
  ok(!p.calls.some(x => x.opts && x.opts.method === 'POST'), 'and saves nothing');
  ok(p.els['mcp-paste'].hidden === true, 'and closes the paste box');
}

console.log('\n=== Config File saves of MCP settings ===');
{
  const fn = CARDS.slice(CARDS.indexOf('function _cfgSavedMessage'), CARDS.indexOf('async function saveConfigFile'));
  const ctx = { loadMCPPanel: () => { ctx.reloaded = true; } };
  vm.createContext(ctx);
  vm.runInContext(fn, ctx);
  const msg = ctx._cfgSavedMessage({ changed: ['mcp_server', 'session_ttl_hours'], applied_now: ['mcp_server', 'mcp_call_timeout_seconds'] }, 'Saved');
  ok(/Saved: session_ttl_hours\. Restart GobboNet/.test(msg) && /mcp_server applied now\./.test(msg) && ctx.reloaded, 'restart for the rest, "applied now" for MCP, and the box reloads', msg);
  ok(ctx._cfgSavedMessage({ changed: ['mcp_server'], applied_now: ['mcp_server'] }, 'Saved') === 'Saved. mcp_server applied now.', 'MCP alone needs no restart');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
