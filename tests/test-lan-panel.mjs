/**
 * CONFIG's "Phone & Other Devices" box -- roadmap 1.7.7 item #7, page half.
 *
 * The server half (the /lan endpoint, and the loopback kept beside a pinned
 * address) is in internal/server/lan_test.go. This covers what only the page
 * can get wrong:
 *
 *   A. Like Idle Stand-Down, the box is always there, and when it cannot work
 *      it says why: opened from a file, the old PowerShell server, an older
 *      program file.
 *   B. It shows every address phones can use, labelled, with COPY, and fills
 *      the choice from what the config file says -- including a saved address
 *      that has since left the PC.
 *   C. It says plainly when phones cannot connect at all.
 *   D. The new address is shown BEFORE saving, with a warning when the address
 *      this page is open at is about to stop working.
 *   E. Saving sends exactly {host, port}, and the result says when it applies
 *      and anything that will stop it applying.
 *   F. It is built from existing pieces, not new ones.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');

const a = SRC.indexOf('/* ================================================================\n   IDLE STAND-DOWN PANEL');
if (a < 0) { console.error('could not locate the server panels in js/15-cards.js'); process.exit(1); }
const BLOCK = SRC.slice(a); // stand-down first: the LAN panel reuses its _sdRelease

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (x, y, l) => ok(x === y, l,
  x === y ? '' : `got:  ${JSON.stringify(x)}\n      want: ${JSON.stringify(y)}`);

const GO_HEALTH = { status: 'ok', server: 'gobbonet', version: '1.7.7-go-abc1234' };
const WIFI = { ip: '192.168.1.20', interface: 'Wi-Fi', kind: 'network adapter', default: true };
const WSL = { ip: '172.20.0.1', interface: 'vEthernet (WSL)', kind: 'virtual adapter', default: false };
const VPN = { ip: '10.8.0.2', interface: 'Tailscale', kind: 'VPN or tunnel', default: false };
const V6 = { ip: 'fd00::20', interface: 'Wi-Fi', kind: 'network adapter', default: false };
const url = (ip, port = 9066) => 'http://' + (ip.includes(':') ? '[' + ip + ']' : ip) + ':' + port + '/';
const withUrls = (list, port) => list.map(c => ({ ...c, url: url(c.ip, port) }));

function lanReply(over = {}) {
  return {
    os: 'linux', port_min: 1024, port_max: 32767,
    running: { host: '0.0.0.0', port: 9066, lan_access: true, local_url: 'http://127.0.0.1:9066/' },
    saved: { host: '0.0.0.0', port: 9066 },
    addresses: withUrls([WIFI, WSL, VPN], 9066),
    choices: [WIFI, V6, WSL, VPN],
    ...over,
  };
}

function build({ served = true, health = GO_HEALTH, lan = lanReply(), lanStatus = 200,
                 post = null, postStatus = 200, here = 'http://127.0.0.1:9066' } = {}) {
  const els = {};
  const mk = (id) => (els[id] = { id, style: {}, value: '', textContent: '', innerHTML: '', dataset: {}, disabled: false });
  ['lan-group', 'lan-addr-list', 'lan-host', 'lan-port', 'lan-save', 'lan-status', 'lan-preview',
   'standdown-group', 'set-standdown-minutes', 'standdown-apply', 'standdown-status'].forEach(mk);
  // innerText reads of the list come from innerHTML in these tests.
  const u = new URL(here);
  const posts = [], urls = [];
  const ctx = {
    console: { warn() {}, log() {}, error() {} },
    IS_SERVED: served,
    window: { location: { origin: u.origin, hostname: u.hostname, port: u.port } },
    document: { getElementById: (id) => els[id] || null },
    escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    Math, JSON, parseInt, Object, String, Number, Array,
    fetch: async (target, opts) => {
      const path = String(target).replace(u.origin, '');
      urls.push(path);
      if (path === '/health-fileserver') {
        if (health === null) throw new Error('unreachable');
        return { ok: true, status: 200, json: async () => health };
      }
      if (path === '/lan' && opts && opts.method === 'POST') {
        posts.push({ body: JSON.parse(opts.body), headers: opts.headers });
        const reply = post || { ok: true, saved: JSON.parse(opts.body) };
        return { ok: postStatus < 300, status: postStatus, json: async () => reply };
      }
      if (path === '/lan') {
        if (lan === null) throw new Error('unreachable');
        return { ok: lanStatus < 300, status: lanStatus, json: async () => lan };
      }
      throw new Error('unexpected ' + path);
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);
  return { ctx, els, posts, urls };
}
const options = (h) => [...h.els['lan-host'].innerHTML.matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)]
  .map(m => [m[1], m[2]]);

/* ================================================================
   A. ALWAYS THERE; SAYS WHY WHEN IT CANNOT WORK
================================================================ */
console.log('\n=== A. a box that cannot work says why ===');
{
  const cannot = async (h, label, expect) => {
    await h.ctx.loadLanPanel();
    ok(h.els['lan-host'].disabled && h.els['lan-port'].disabled && h.els['lan-save'].disabled,
       label + ': the controls are disabled');
    ok(expect.test(h.els['lan-status'].textContent), label + ': and says why', h.els['lan-status'].textContent);
    eq(h.els['lan-addr-list'].innerHTML, '', label + ': and lists nothing it cannot vouch for');
    eq(h.posts.length, 0, label + ': nothing is sent');
  };
  await cannot(build({ served: false }), 'opened from a file', /from a file/i);
  await cannot(build({ health: { status: 'ok', server: 'fileserver.ps1' } }), 'PowerShell server', /fileserver\.ps1/);
  await cannot(build({ health: { status: 'ok', pid: 1 } }), 'PowerShell server from before it named itself', /fileserver\.ps1/);
  await cannot(build({ lanStatus: 404, lan: {} }), 'an older program file', /arrived in 1\.7\.7\. This one is 1\.7\.7\./);
  await cannot(build({ lanStatus: 500, lan: {} }), 'a server error', /error 500/);
  await cannot(build({ lan: null }), 'an unreachable server', /could not reach/i);
}

/* ================================================================
   B. THE ADDRESSES, AND THE CHOICE
================================================================ */
console.log('\n=== B. every address phones can use, and the choice ===');
{
  const h = build();
  await h.ctx.loadLanPanel();
  const list = h.els['lan-addr-list'].innerHTML;
  const rows = list.split('<div class="about-build-row"').slice(1);
  eq(rows.length, 3, 'one row per address the server is answering on');
  ok(/<span>Wi-Fi<\/span><b>http:\/\/192\.168\.1\.20:9066\/<\/b>/.test(rows[0]), 'first row: the adapter, then the address, in the server’s order', rows[0]);
  ok(/data-url="http:\/\/192\.168\.1\.20:9066\/" onclick="copyLanAddress\(this\)">COPY<\/button>/.test(rows[0]), 'each row has its own COPY button');
  ok(/vEthernet \(WSL\) — virtual adapter, unlikely/.test(rows[1]) && /Tailscale — VPN or tunnel, unlikely/.test(rows[2]),
     'virtual adapters and VPNs carry the startup banner’s "unlikely"');
  ok(!h.els['lan-host'].disabled && !h.els['lan-save'].disabled, 'the controls are enabled');

  const opts = options(h);
  eq(opts[0][0] + ' / ' + opts[0][1], '0.0.0.0 / Automatic (all addresses)', 'Automatic comes first');
  eq(opts.map(o => o[0]).join(' '), '0.0.0.0 192.168.1.20 fd00::20 172.20.0.1 10.8.0.2 127.0.0.1',
     'then every address this PC has, then this PC only');
  eq(opts[opts.length - 1][1], 'This PC only (no phones)', 'this PC only says what it costs');
  eq(h.els['lan-host'].value, '0.0.0.0', 'the choice is what the config file says');
  eq(h.els['lan-port'].value, 9066, 'and so is the port');
  eq(h.els['lan-status'].textContent, '', 'nothing pending, nothing to say');

  // A saved wildcard or loopback keeps its own spelling when saved again.
  const v6 = build({ lan: lanReply({ saved: { host: '::', port: 9066 } }) });
  await v6.ctx.loadLanPanel();
  eq(options(v6)[0][0], '::', 'a saved "::" stays "::" under Automatic');

  // An address that has since left the PC is shown as what the file says.
  const gone = build({ lan: lanReply({ saved: { host: '192.168.7.7', port: 9066 },
                                        running: { host: '127.0.0.1', port: 9066, lan_access: false, fell_back: true, bind_error: 'cannot assign requested address' } }) });
  await gone.ctx.loadLanPanel();
  ok(options(gone).some(o => o[0] === '192.168.7.7' && /no longer on this PC/.test(o[1])),
     'a saved address no longer on this PC is listed as such');
  eq(gone.els['lan-host'].value, '192.168.7.7', 'and selected, rather than pretending otherwise');

  // Names come from the OS; they are escaped like anything else.
  const evil = build({ lan: lanReply({ addresses: withUrls([{ ...WIFI, interface: '<img src=x onerror=1>' }], 9066),
                                        choices: [{ ...WIFI, interface: '<img src=x onerror=1>' }] }) });
  await evil.ctx.loadLanPanel();
  ok(!/<img/.test(evil.els['lan-addr-list'].innerHTML) && !/<img/.test(evil.els['lan-host'].innerHTML),
     'adapter names are escaped in the rows and the choice');
}

/* ================================================================
   C. WHEN PHONES CANNOT CONNECT
================================================================ */
console.log('\n=== C. it says when phones cannot connect ===');
{
  const local = build({ lan: lanReply({ running: { host: '127.0.0.1', port: 9066, lan_access: false },
                                         saved: { host: '127.0.0.1', port: 9066 }, addresses: [] }) });
  await local.ctx.loadLanPanel();
  ok(/set to answer on this PC only\. Choose Automatic below/.test(local.els['lan-addr-list'].innerHTML),
     'set to this PC only: says so, and how to let phones in');
  eq(local.els['lan-host'].value, '127.0.0.1', 'and "This PC only" is what is chosen');

  const denied = build({ lan: lanReply({ running: { host: '127.0.0.1', port: 9066, lan_access: false, fell_back: true,
                                                    bind_error: 'bind: permission denied' }, addresses: [] }) });
  await denied.ctx.loadLanPanel();
  ok(/could not open its network address \(bind: permission denied\)/.test(denied.els['lan-addr-list'].innerHTML),
     'a refused network bind: says so, with the real error');

  const none = build({ lan: lanReply({ addresses: [] }) });
  await none.ctx.loadLanPanel();
  ok(/No Wi-Fi or Ethernet address was found/.test(none.els['lan-addr-list'].innerHTML), 'no address at all: says so');

  const env = build({ lan: lanReply({ env_overrides: ['GOBBONET_LISTEN_PORT'] }) });
  await env.ctx.loadLanPanel();
  ok(/GOBBONET_LISTEN_PORT is set on this PC, and wins over this setting/.test(env.els['lan-status'].textContent)
     && env.els['lan-status'].dataset.tone === 'err', 'an environment override is named, as a problem');

  const pending = build({ lan: lanReply({ saved: { host: '0.0.0.0', port: 9070 } }) });
  await pending.ctx.loadLanPanel();
  ok(/A saved change is waiting: it applies the next time GobboNet starts/.test(pending.els['lan-status'].textContent),
     'a saved change that is not running yet is pointed out');
}

/* ================================================================
   D. THE NEW ADDRESS, BEFORE SAVING
================================================================ */
console.log('\n=== D. the new address is shown before anything is saved ===');
{
  const preview = async (opts, host, port) => {
    const h = build(opts);
    await h.ctx.loadLanPanel();
    h.els['lan-host'].value = host; h.els['lan-port'].value = String(port);
    h.ctx.updateLanPreview();
    return h.els['lan-preview'].textContent;
  };
  eq(await preview({}, '0.0.0.0', 9066), '', 'nothing changed, nothing shown');
  ok(/from 1024 to 32767/.test(await preview({}, '0.0.0.0', 80)), 'a port outside the range says so');
  ok(/from 1024 to 32767/.test(await preview({}, '0.0.0.0', 9066.5)), 'and so does a fraction');

  const p = await preview({}, '0.0.0.0', 9070);
  ok(/phones use http:\/\/192\.168\.1\.20:9070\/ \(or another address above\); this PC uses http:\/\/127\.0\.0\.1:9070\/\./.test(p),
     'a new port: what phones and this PC will use', p);
  ok(/will stop working then — note the new one first/.test(p), 'and this page’s own address is about to change');
  ok(!/LAN Setup/.test(p), 'no Windows advice off Windows');
  ok(/run GobboNet LAN Setup again/.test(await preview({ lan: lanReply({ os: 'windows' }) }, '0.0.0.0', 9070)),
     'on Windows, a new port needs LAN Setup again for the firewall');
  ok(!/LAN Setup/.test(await preview({ lan: lanReply({ os: 'windows' }) }, '192.168.1.20', 9066)),
     'but a new address on the same port does not');

  const pin = await preview({}, '192.168.1.20', 9066);
  ok(/phones use http:\/\/192\.168\.1\.20:9066\/; this PC uses http:\/\/127\.0\.0\.1:9066\/\.$/.test(pin),
     'pinning an address: phones use it, this PC keeps 127.0.0.1, and this page (on 127.0.0.1) is unaffected', pin);

  const fromPhone = { here: 'http://192.168.1.20:9066' };
  ok(!/stop working/.test(await preview(fromPhone, '192.168.1.20', 9066)), 'from a phone, pinning the address it is on: no warning');
  ok(/stop working/.test(await preview(fromPhone, '172.20.0.1', 9066)), 'from a phone, pinning a different one: warned');
  ok(/open on another device, which won’t reach GobboNet after that/.test(await preview(fromPhone, '127.0.0.1', 9066)),
     'from a phone, choosing this PC only: warned that it will be cut off');
  ok(/phones can’t connect; this PC uses http:\/\/127\.0\.0\.1:9066\/\.$/.test(await preview({}, '127.0.0.1', 9066)),
     'from this PC, choosing this PC only: no warning, and says phones cannot connect');

  // 0.0.0.0 answers on IPv4 only, so the example address must be IPv4.
  const v6first = await preview({ lan: lanReply({ choices: [V6, WIFI] }) }, '0.0.0.0', 9070);
  ok(/http:\/\/192\.168\.1\.20:9070\//.test(v6first) && !/fd00/.test(v6first), 'Automatic (0.0.0.0) gives an IPv4 example');
}

/* ================================================================
   E. SAVING
================================================================ */
console.log('\n=== E. saving ===');
{
  const save = async (opts, host, port) => {
    const h = build(opts);
    await h.ctx.loadLanPanel();
    h.els['lan-host'].value = host; h.els['lan-port'].value = String(port);
    await h.ctx.saveLanSettings();
    return h;
  };
  let h = await save({}, '192.168.1.20', 9070);
  eq(JSON.stringify(h.posts.map(p => p.body)), '[{"host":"192.168.1.20","port":9070}]', 'sends exactly {host, port}, the port as a number');
  eq(h.posts[0].headers['Content-Type'], 'application/json', 'as JSON');
  ok(/Saved\. GobboNet uses this from its next start; until then nothing changes\./.test(h.els['lan-status'].textContent)
     && h.els['lan-status'].dataset.tone === 'ok', 'says when it applies');

  h = await save({}, '0.0.0.0', 9066);
  ok(/This is what GobboNet is using now, so nothing changes/.test(h.els['lan-status'].textContent), 'saving what is running says so');

  h = await save({}, '0.0.0.0', 70000);
  eq(h.posts.length, 0, 'an out-of-range port is not sent');
  ok(/from 1024 to 32767/.test(h.els['lan-status'].textContent) && h.els['lan-status'].dataset.tone === 'err', 'and says why');

  h = await save({ post: { error: 'Port 9070 is being used by another program right now, so GobboNet could not start on it. Pick another.' }, postStatus: 409 }, '0.0.0.0', 9070);
  ok(/being used by another program/.test(h.els['lan-status'].textContent) && h.els['lan-status'].dataset.tone === 'err',
     'the server’s refusal is shown as it said it');

  h = await save({ post: { ok: true, saved: { host: '0.0.0.0', port: 9070 }, env_overrides: ['GEMMA_LISTEN_PORT'] } }, '0.0.0.0', 9070);
  ok(/GEMMA_LISTEN_PORT is set on this PC, and wins/.test(h.els['lan-status'].textContent) && h.els['lan-status'].dataset.tone === 'err',
     'a save an environment variable will override is not reported as a plain success');

  h = await save({ post: { ok: true, saved: { host: '0.0.0.0', port: 9070 }, port_file_error: 'access is denied' } }, '0.0.0.0', 9070);
  ok(/could not be recorded for launch\.bat \(access is denied\)/.test(h.els['lan-status'].textContent), 'a sidecar that could not be written is said');
}

/* ================================================================
   F. BUILT FROM EXISTING PIECES
================================================================ */
console.log('\n=== F. built from what CONFIG already has ===');
{
  const box = HTML.slice(HTML.indexOf('<div class="form-group" id="lan-group"'), HTML.indexOf('id="lan-status"'));
  ok(box.length > 100, 'the box is in chat.html');
  // data-tour (1.7.9, the tour's target) is not styling; the style is what is pinned.
  ok(box.replace(/ data-tour="[^"]*"/, '').startsWith('<div class="form-group" id="lan-group" style="margin-top:12px; padding:12px; border:1px solid rgba(0,243,255,0.18); border-radius:var(--radius); background:rgba(0,243,255,0.02);">'),
     'the box is Idle Stand-Down’s cyan box, exactly');
  const sd = HTML.match(/<div class="form-group" id="standdown-group" (style="[^"]*")/)[1];
  ok(box.includes(sd), 'character for character');
  ok(/<div class="form-row" style="margin-top:12px;">\s*<div class="form-group">\s*<label for="lan-host">/.test(box),
     'address and port sit in Performance’s form-row');
  ok(/<button class="btn btn-sm" id="lan-save" onclick="saveLanSettings\(\)">SAVE FOR NEXT START<\/button>/.test(box),
     'one SAVE FOR NEXT START button, Performance’s wording and class');
  ok(/class="about-build-rows" id="lan-addr-list"/.test(box), 'the address rows are ABOUT’s build rows');
  ok(/<div class="standdown-status" id="lan-status"><\/div>/.test(HTML), 'the status line is Idle Stand-Down’s');
  // 1.7.9 (F3): in Devices & Network, with the other way in, Network access.
  const net = HTML.slice(HTML.indexOf('data-cfg-section="network"'), HTML.indexOf('</section>', HTML.indexOf('data-cfg-section="network"')));
  ok(net.includes('id="lan-group"') && net.includes('id="network-hosts-group"') &&
     net.indexOf('id="lan-group"') < net.indexOf('id="network-hosts-group"'), 'in Devices & Network, first, above Network access');
  ok(/DHCP reservation/.test(box), 'it says the one thing GobboNet cannot do, and who can');

  const open = SRC.slice(SRC.indexOf('function openSettings()'), SRC.indexOf('function closeSettings()'));
  ok(/loadLanPanel\(\);/.test(open), 'opening CONFIG fills it');
  const saveSettings = SRC.slice(SRC.indexOf('function saveSettings()'), SRC.indexOf('/* ===', SRC.indexOf('function saveSettings()')));
  ok(!/lan-/.test(saveSettings), 'CONFIG’s SAVE does not write it -- a server setting has its own button');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
