/* @gobbonet-split js/26-mcp.js
   Hand-written module -- NOT produced by refactor-split.py.
   MCP servers (1.8.0, #16): CONFIG > Advanced > MCP Servers.
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   MCP SERVERS

   An MCP server is a program on the PC GobboNet runs on that offers
   tools a character can call. The server side is internal/mcp (the
   protocol and the programs) and internal/server/mcp.go (who may do
   what); the tables live in config.toml as [[mcp_server]].

   This file is the CONFIG box: the list, each server's state, and the
   form that adds or changes one. What the server decides, the page
   only reflects:

     - adding, changing, switching on and removing need a browser on
       this PC (the server answers 403 anywhere else, and says so in
       /mcp/servers' "reason"), so off the PC only SWITCH OFF and
       CHECK TOOLS are offered;
     - env values are not sent to other devices at all.

   Everything is built with textContent and addEventListener. A server
   name, a command, a tool's description: all of it comes from
   config.toml or from the program, and none of it is HTML.
================================================================ */

const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MCP_ENV_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const _mcp = { body: null, editing: null, polls: 0, pollTimer: null, tools: {} };

/* What a state means, for a person. st is one entry of /mcp/servers or
   /mcp/tools. */
function mcpStateText(st) {
  if (!st || !st.enabled) return 'Off';
  switch (st.state) {
    case 'idle': return 'On. Starts when a character first needs it.';
    case 'starting': return 'Starting…';
    case 'ready': {
      const n = Number(st.tool_count) || 0;
      return 'Running, ' + n + (n === 1 ? ' tool' : ' tools') + '.';
    }
    case 'failed': {
      const wait = Number(st.retry_in_seconds) || 0;
      return 'Not working' + (wait ? ' (tries again in ' + wait + ' s)' : '') + '.';
    }
    case 'off': return 'Off';
  }
  return String(st.state || '');
}

/* One argument per line. Spaces at either end of a line are dropped (a
   pasted path rarely means them) and empty lines are skipped. */
function mcpArgsFromText(text) {
  return String(text || '').split(/\r?\n/).map(l => l.trim()).filter(l => l !== '');
}

function mcpArgsToText(args) {
  return (Array.isArray(args) ? args : []).join('\n');
}

/* NAME=value per line. Returns { env } or { error }. */
function mcpEnvFromText(text) {
  const env = {};
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, '');
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) return { error: 'Environment line ' + (i + 1) + ': write NAME=value.' };
    const name = line.slice(0, eq).trim();
    if (!MCP_ENV_RE.test(name)) return { error: 'Environment line ' + (i + 1) + ': ' + name + ' is not a variable name (letters, digits and _).' };
    env[name] = line.slice(eq + 1);
  }
  return { env };
}

function mcpEnvToText(env) {
  if (!env || typeof env !== 'object') return '';
  return Object.keys(env).sort().map(k => k + '=' + env[k]).join('\n');
}

/* A name GobboNet accepts, made from whatever a pasted setup called it. */
function mcpSafeName(raw) {
  let n = String(raw || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+/, '').replace(/-+$/, '');
  return n.slice(0, 32);
}

/* Most MCP servers document their setup as the JSON other apps use:
   { "mcpServers": { "name": { "command", "args", "env" } } }. This reads
   that, a bare { "name": {...} }, or a bare { "command": ... }, and fills
   the form for the user to check -- it never saves. A remote server ("url")
   is said to be out of scope rather than half-filled. */
function parseMCPJson(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim()); }
  catch (_) { return { error: 'That is not JSON. Paste the whole { ... } block from the instructions.' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'Expected a { ... } block.' };
  let name = '', entry = null;
  const servers = data.mcpServers || data.servers || data.mcp_servers;
  if (servers && typeof servers === 'object') {
    const names = Object.keys(servers);
    if (!names.length) return { error: 'The block lists no servers.' };
    name = names[0];
    entry = servers[name];
  } else if (typeof data.command === 'string' || typeof data.url === 'string') {
    entry = data;
    name = data.name || '';
  } else {
    const names = Object.keys(data);
    if (names.length >= 1 && data[names[0]] && typeof data[names[0]] === 'object') {
      name = names[0];
      entry = data[name];
    }
  }
  if (!entry || typeof entry !== 'object') return { error: 'Could not find a server in that block.' };
  if (typeof entry.command !== 'string' || !entry.command.trim()) {
    if (entry.url || entry.type === 'http' || entry.type === 'sse' || entry.type === 'streamable-http') {
      return { error: 'That is a server on the internet (it has a url). GobboNet runs MCP servers on this PC only.' };
    }
    return { error: 'The server in that block has no command.' };
  }
  const args = Array.isArray(entry.args) ? entry.args.filter(a => typeof a === 'string' || typeof a === 'number').map(String) : [];
  const env = {};
  if (entry.env && typeof entry.env === 'object') {
    for (const [k, v] of Object.entries(entry.env)) {
      if (MCP_ENV_RE.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) env[k] = String(v);
    }
  }
  return { server: { name: mcpSafeName(name), command: entry.command.trim(), args, env } };
}

function _mcpEls() {
  const id = x => document.getElementById(x);
  return {
    group: id('mcp-group'), note: id('mcp-note'), list: id('mcp-list'), add: id('mcp-add'),
    form: id('mcp-form'), name: id('mcp-f-name'), command: id('mcp-f-command'), args: id('mcp-f-args'),
    env: id('mcp-f-env'), enabled: id('mcp-f-enabled'), save: id('mcp-f-save'), cancel: id('mcp-f-cancel'),
    json: id('mcp-f-json'), jsonFill: id('mcp-f-json-fill'), status: id('mcp-status'),
    pasteToggle: id('mcp-f-paste'), paste: id('mcp-paste'),
  };
}

function _mcpStatus(msg, tone) {
  const { status } = _mcpEls();
  if (!status) return;
  status.textContent = msg || '';
  if (tone) status.dataset.tone = tone; else delete status.dataset.tone;
}

async function _mcpFetch(path, opts) {
  const resp = await fetch(window.location.origin + path, Object.assign({ cache: 'no-store' }, opts || {}));
  let data = {};
  try { data = await resp.json(); } catch (_) {}
  if (resp.status === 401) throw Object.assign(new Error('Sign in again, then reopen CONFIG.'), { shown: true });
  return { resp, data };
}

function _mcpEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
}

function _mcpButton(label, onClick, cls) {
  const b = _mcpEl('button', 'btn btn-sm' + (cls ? ' ' + cls : ''), label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function _mcpCommandLine(s) {
  const quote = a => (a === '' || /[\s"]/.test(a)) ? JSON.stringify(a) : a;
  return [s.command].concat((s.args || []).map(quote)).join(' ');
}

function _mcpRender() {
  const els = _mcpEls();
  const body = _mcp.body;
  if (!els.list || !body) return;
  const manage = !!body.can_manage && body.editable !== false;
  els.list.textContent = '';
  els.note.textContent = body.can_manage ? '' : (body.reason || '');
  if (body.editable === false) els.note.textContent = 'This server was started without a config file, so MCP servers cannot be kept.';
  els.add.style.display = manage ? '' : 'none';
  els.add.disabled = (body.servers || []).length >= (Number(body.max_servers) || 32);
  const servers = Array.isArray(body.servers) ? body.servers : [];
  if (!servers.length) {
    els.list.appendChild(_mcpEl('div', 'mcp-empty', manage
      ? 'None yet. ADD SERVER sets one up; its instructions usually give the program and arguments.'
      : 'None set up.'));
  }
  for (const s of servers) {
    const card = _mcpEl('div', 'mcp-server');
    card.dataset.name = s.name;
    card.dataset.state = s.enabled ? s.state : 'off';
    const head = _mcpEl('div', 'mcp-server-head');
    head.appendChild(_mcpEl('span', 'mcp-server-name', s.name));
    head.appendChild(_mcpEl('span', 'mcp-server-state', mcpStateText(s)));
    card.appendChild(head);
    card.appendChild(_mcpEl('code', 'mcp-server-cmd', _mcpCommandLine(s)));
    const envNames = Object.keys(s.env || {});
    if (envNames.length) card.appendChild(_mcpEl('div', 'mcp-server-env', 'Environment: ' + envNames.sort().join(', ')));
    card.appendChild(_mcpEl('div', 'mcp-server-warn', 'Runs on this PC with your permissions.'));
    if (s.server && s.server.name) {
      card.appendChild(_mcpEl('div', 'mcp-server-info', 'Says it is ' + s.server.name + (s.server.version ? ' ' + s.server.version : '') + '.'));
    }
    if (s.detail) card.appendChild(_mcpEl('div', 'mcp-server-detail', s.detail));

    const row = _mcpEl('div', 'mcp-server-actions');
    if (s.enabled) {
      row.appendChild(_mcpButton('SWITCH OFF', () => mcpSwitch(s.name, false)));
      row.appendChild(_mcpButton('CHECK TOOLS', () => mcpCheckTools(s.name)));
    } else if (manage) {
      row.appendChild(_mcpButton('SWITCH ON', () => mcpSwitch(s.name, true), 'btn-fill'));
    }
    if (manage) {
      row.appendChild(_mcpButton('EDIT', () => openMCPForm(s.name)));
      row.appendChild(_mcpButton('REMOVE', () => mcpRemove(s.name)));
    }
    card.appendChild(row);
    const tools = _mcp.tools[s.name];
    if (tools) card.appendChild(_mcpToolList(tools));
    els.list.appendChild(card);
  }
  _mcpSchedulePoll(servers.some(s => s.enabled && s.state === 'starting'));
}

function _mcpToolList(tools) {
  const box = _mcpEl('div', 'mcp-tools');
  if (!tools.length) {
    box.appendChild(_mcpEl('div', 'mcp-empty', 'It offers no tools.'));
    return box;
  }
  for (const t of tools) {
    const item = _mcpEl('div', 'mcp-tool');
    item.appendChild(_mcpEl('code', 'mcp-tool-name', t.name));
    if (t.read_only) item.appendChild(_mcpEl('span', 'mcp-tool-ro', 'says it only reads'));
    // The first sentence, or 160 characters: enough to say what it does.
    // The whole description is what the character reads.
    let desc = String(t.description || t.title || '').trim().replace(/\s+/g, ' ');
    const stop = desc.search(/[.!?](\s|$)/);
    if (stop > 0 && stop < 160) desc = desc.slice(0, stop + 1);
    else if (desc.length > 160) desc = desc.slice(0, 160) + '…';
    if (desc) {
      const d = _mcpEl('div', 'mcp-tool-desc', desc);
      d.title = String(t.description || '');
      item.appendChild(d);
    }
    box.appendChild(item);
  }
  return box;
}

/* While a server starts, ask again every two seconds, for up to two
   minutes, and only while CONFIG is open. */
function _mcpSchedulePoll(wanted) {
  clearTimeout(_mcp.pollTimer);
  _mcp.pollTimer = null;
  const modal = document.getElementById('settings-modal');
  if (!wanted || !modal || !modal.classList.contains('open') || _mcp.polls >= 60) return;
  _mcp.polls++;
  _mcp.pollTimer = setTimeout(() => { loadMCPPanel(true); }, 2000);
}

async function loadMCPPanel(fromPoll) {
  const els = _mcpEls();
  if (!els.group) return;
  _mcpWire();
  if (!fromPoll) { _mcp.polls = 0; _mcp.tools = {}; }
  if (!IS_SERVED) {
    els.note.textContent = 'Opened from a file rather than the GobboNet server, so there are no MCP servers here.';
    els.list.textContent = '';
    els.add.style.display = 'none';
    return;
  }
  try {
    const { resp, data } = await _mcpFetch('/mcp/servers');
    if (!resp.ok) throw new Error(data.error || 'unavailable');
    _mcp.body = data;
    _mcpRender();
  } catch (e) {
    els.note.textContent = e.shown ? e.message : 'MCP servers are unavailable. Update GobboNet if this server does not offer them.';
    els.list.textContent = '';
    els.add.style.display = 'none';
  }
}

async function _mcpAct(payload, doing, done) {
  _mcpStatus(doing, '');
  try {
    const { resp, data } = await _mcpFetch('/mcp/servers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      _mcpStatus(data.error || ('Not saved (HTTP ' + resp.status + ').'), 'err');
      return false;
    }
    _mcp.body = data;
    _mcpRender();
    _mcpStatus(done, 'ok');
    return true;
  } catch (e) {
    _mcpStatus(e.shown ? e.message : 'Could not reach GobboNet. Reopen CONFIG to see what was saved.', 'err');
    return false;
  }
}

function mcpSwitch(name, on) {
  delete _mcp.tools[name];
  return _mcpAct({ action: on ? 'enable' : 'disable', name },
    on ? 'Switching ' + name + ' on…' : 'Switching ' + name + ' off…',
    on ? name + ' is on. It starts when a character first needs its tools.' : name + ' is off, and stopped if it was running.');
}

function mcpRemove(name) {
  if (!confirm('Remove the MCP server ' + name + ' from config.toml? Characters lose its tools.')) return;
  delete _mcp.tools[name];
  return _mcpAct({ action: 'remove', name }, 'Removing ' + name + '…', name + ' was removed.');
}

/* CHECK TOOLS: start it if need be and list what it offers. */
async function mcpCheckTools(name) {
  _mcpStatus('Asking ' + name + ' for its tools… a first start can take a minute.', '');
  try {
    const { resp, data } = await _mcpFetch('/mcp/tools?refresh=1');
    if (!resp.ok) throw Object.assign(new Error(data.error || ('HTTP ' + resp.status)), { shown: true });
    const st = (data.servers || []).find(s => s.name === name);
    if (!st) { _mcpStatus(name + ' is not set up any more.', 'err'); return; }
    if (st.state === 'ready') {
      _mcp.tools[name] = Array.isArray(st.tools) ? st.tools : [];
      _mcpStatus(name + ' offers ' + _mcp.tools[name].length + (_mcp.tools[name].length === 1 ? ' tool.' : ' tools.'), 'ok');
    } else if (st.state === 'starting') {
      _mcpStatus(name + ' is still starting. CHECK TOOLS again in a moment.', '');
    } else {
      _mcpStatus(name + ': ' + (st.detail || mcpStateText(st)), 'err');
    }
    // Merge the fresh state into the list.
    for (const s of (_mcp.body && _mcp.body.servers) || []) {
      const fresh = (data.servers || []).find(x => x.name === s.name);
      if (fresh) Object.assign(s, { state: fresh.state, detail: fresh.detail, retry_in_seconds: fresh.retry_in_seconds, tool_count: fresh.tool_count, server: fresh.server });
    }
    _mcpRender();
  } catch (e) {
    _mcpStatus(e.shown ? e.message : 'Could not reach GobboNet.', 'err');
  }
}

function openMCPForm(name) {
  const els = _mcpEls();
  if (!els.form) return;
  const s = name ? ((_mcp.body && _mcp.body.servers) || []).find(x => x.name === name) : null;
  _mcp.editing = s ? s.name : '';
  els.name.value = s ? s.name : '';
  els.command.value = s ? s.command : '';
  els.args.value = s ? mcpArgsToText(s.args) : '';
  els.env.value = s ? mcpEnvToText(s.env) : '';
  els.enabled.checked = s ? !!s.enabled : false;
  els.json.value = '';
  _mcpShowPaste(false);
  els.form.hidden = false;
  els.add.style.display = 'none';
  _mcpStatus(s ? 'Editing ' + s.name + '. Saving restarts it if it is running.' : 'A new server starts switched off unless you tick Switched on.');
  try { (s ? els.command : els.name).focus(); } catch (_) {}
}

function closeMCPForm() {
  const els = _mcpEls();
  if (!els.form) return;
  els.form.hidden = true;
  _mcp.editing = null;
  if (_mcp.body && _mcp.body.can_manage) els.add.style.display = '';
}

/* The form as a server table, or { error }. */
function _mcpFormServer() {
  const els = _mcpEls();
  const name = els.name.value.trim();
  if (!MCP_NAME_RE.test(name)) return { error: 'The name is 1 to 32 lowercase letters, digits, - and _, starting with a letter or digit.' };
  const command = els.command.value.trim();
  if (!command) return { error: 'Say which program to start.' };
  const env = mcpEnvFromText(els.env.value);
  if (env.error) return env;
  return { server: { name, command, args: mcpArgsFromText(els.args.value), env: env.env, enabled: !!els.enabled.checked } };
}

async function saveMCPForm() {
  const got = _mcpFormServer();
  if (got.error) { _mcpStatus(got.error, 'err'); return; }
  const was = _mcp.editing || '';
  const ok = await _mcpAct({ action: 'save', name: was, server: got.server }, 'Saving ' + got.server.name + '…',
    got.server.name + ' was saved' + (got.server.enabled ? ' and is on.' : '. SWITCH ON when you are ready.'));
  if (ok) {
    delete _mcp.tools[was];
    closeMCPForm();
  }
}

function fillMCPFormFromJson() {
  const els = _mcpEls();
  const got = parseMCPJson(els.json.value);
  if (got.error) { _mcpStatus(got.error, 'err'); return; }
  const s = got.server;
  if (!_mcp.editing && s.name) els.name.value = s.name;
  els.command.value = s.command;
  els.args.value = mcpArgsToText(s.args);
  els.env.value = mcpEnvToText(s.env);
  _mcpShowPaste(false);
  _mcpStatus('Filled in. Check the program and arguments, then SAVE SERVER.', 'ok');
}

function _mcpShowPaste(on) {
  const els = _mcpEls();
  if (!els.paste || !els.pasteToggle) return;
  els.paste.hidden = !on;
  els.pasteToggle.setAttribute('aria-expanded', on ? 'true' : 'false');
  if (on) { try { els.json.focus(); } catch (_) {} }
}

let _mcpWired = false;
function _mcpWire() {
  if (_mcpWired) return;
  const els = _mcpEls();
  if (!els.add) return;
  _mcpWired = true;
  els.add.addEventListener('click', () => openMCPForm(''));
  els.save.addEventListener('click', saveMCPForm);
  els.cancel.addEventListener('click', () => { closeMCPForm(); _mcpStatus(''); });
  els.jsonFill.addEventListener('click', fillMCPFormFromJson);
  els.pasteToggle.addEventListener('click', () => _mcpShowPaste(els.paste.hidden));
}
