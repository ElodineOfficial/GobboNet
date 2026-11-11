/* GobboNet 1.8.0, round 9 -- console check for MCP servers (roadmap #16,
 * issue #42): the server side and the CONFIG > Advanced > MCP Servers box.
 * Characters do not call MCP tools yet; that is the next round.
 *
 * Paste into the browser console with GobboNet open and signed in.
 *
 * As it is, it changes nothing: it reads /mcp/servers and /mcp/tools, and
 * makes requests that must be refused.
 *
 * On the PC GobboNet runs on, with Node.js installed, run this first to also
 * add a test server, use it, and remove it again:
 *
 *     window.GN_MCP_TEST = true
 *
 * The test server is "gn-r9-test": npx -y @modelcontextprotocol/server-everything,
 * the protocol's reference server. npx downloads it the first time, which can
 * take a minute. It is removed from config.toml at the end, pass or fail.
 */
(async () => {
  const out = [];
  const log = (status, msg) => {
    out.push({ status, msg });
    const style = { PASS: 'color:#0a0', FAIL: 'color:#d00;font-weight:bold', INFO: 'color:#888' }[status];
    console.log(`%c${status}%c  [round 9] ${msg}`, style, '');
  };
  const check = (c, msg) => log(c ? 'PASS' : 'FAIL', msg);
  const done = () => {
    const fails = out.filter(o => o.status === 'FAIL').length;
    const passes = out.filter(o => o.status === 'PASS').length;
    console.log(`%c1.8.0 round 9: ${passes} passed, ${fails} failed`, `font-weight:bold;color:${fails ? '#d00' : '#0a0'}`);
    return { passes, fails, results: out };
  };
  const fn = name => typeof window[name] === 'function';
  const req = async (method, path, body) => {
    const r = await fetch(path, {
      method, cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await r.json(); } catch (_) {}
    return { status: r.status, data };
  };
  const call = (server, tool, args, extra) => req('POST', '/mcp/call', Object.assign({ server, tool, arguments: args || {} }, extra || {}));

  if (!fn('loadMCPPanel') || !fn('parseMCPJson') || !fn('mcpStateText')) {
    log('FAIL', 'this page has no loadMCPPanel / parseMCPJson: it is older than round 9. Replace the gobbonet program file with the one from the zip and reload.');
    return done();
  }

  // ---- the box -------------------------------------------------------------
  log('INFO', '--- CONFIG > Advanced > MCP Servers ---');
  const group = document.getElementById('mcp-group');
  check(!!group && !!group.closest('#cfg-advanced'), 'the MCP Servers box is in CONFIG > Advanced');
  const servers = await req('GET', '/mcp/servers');
  check(servers.status === 200 && Array.isArray(servers.data.servers), `/mcp/servers answers: ${servers.status === 200 ? servers.data.servers.length + ' server(s) set up' : 'HTTP ' + servers.status}`);
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  check(servers.data.can_manage === local, local
    ? 'on this PC: you may add, change and switch on servers here'
    : 'on another device: you may only switch servers off here (' + (servers.data.reason || 'no reason given') + ')');
  for (const s of servers.data.servers || []) log('INFO', `${s.name}: ${mcpStateText(s)}${s.detail ? ' ' + s.detail : ''}`);
  if (!local) {
    const leaked = (servers.data.servers || []).some(s => Object.values(s.env || {}).some(v => v !== '(hidden)'));
    check(!leaked, 'env values are not sent to this device, only their names');
  }

  // ---- what must be refused ------------------------------------------------
  log('INFO', '--- Refusals ---');
  const nobody = await call('gn-no-such-server', 'echo', {});
  check(nobody.status === 404 && nobody.data.kind === 'unknown_server', `a call to a server that does not exist: ${nobody.status} ${nobody.data.kind || ''}`);
  const badArgs = await req('POST', '/mcp/call', { tool: 'echo' });
  check(badArgs.status === 400, `a call that names no server: ${badArgs.status}`);
  if (!local) {
    const add = await req('POST', '/mcp/servers', { action: 'save', name: '', server: { name: 'gn-r9-phone', command: 'calc', args: [], enabled: true } });
    check(add.status === 403, `adding a server from this device is refused: ${add.status}`);
    const on = await req('POST', '/mcp/servers', { action: 'enable', name: 'gn-r9-phone' });
    check(on.status === 403, `switching one on from this device is refused: ${on.status}`);
  }
  log('INFO', 'Another website cannot list or call tools: the Go tests (internal/server/mcp_test.go) check every cross-site case, which a page cannot send at itself.');

  const tools = await req('GET', '/mcp/tools');
  check(tools.status === 200 && Array.isArray(tools.data.servers) && tools.data.call_timeout_seconds > 0,
    `/mcp/tools answers, with call_timeout_seconds = ${tools.data.call_timeout_seconds}`);

  const pasted = parseMCPJson('{"mcpServers":{"Files":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/tmp"]}}}');
  check(pasted.server && pasted.server.name === 'files' && pasted.server.args.length === 3, 'PASTE A SETUP reads the usual {"mcpServers": ...} block');

  // ---- the test server -----------------------------------------------------
  if (!window.GN_MCP_TEST) {
    log('INFO', 'To try a real MCP server too: on the PC GobboNet runs on, with Node.js installed, run  window.GN_MCP_TEST = true  and paste this again.');
  } else if (!local) {
    log('INFO', 'GN_MCP_TEST is set, but servers can only be added on the PC GobboNet runs on. Open it there.');
  } else {
    const NAME = 'gn-r9-test';
    log('INFO', `--- The test server "${NAME}" ---`);
    await req('POST', '/mcp/servers', { action: 'remove', name: NAME }); // a leftover from an earlier run
    try {
      const saved = await req('POST', '/mcp/servers', { action: 'save', name: '', server: { name: NAME, command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'], env: {}, enabled: true } });
      check(saved.status === 200 && saved.data.servers.some(s => s.name === NAME && s.state === 'idle'), `added and switched on; not started until needed (state "${(saved.data.servers || []).filter(s => s.name === NAME).map(s => s.state)[0]}")`);

      log('INFO', 'starting it (npx may download it first; up to two minutes)…');
      let st = null;
      const until = Date.now() + 150000;
      while (Date.now() < until) {
        const t = await req('GET', '/mcp/tools');
        st = (t.data.servers || []).find(s => s.name === NAME);
        if (!st || st.state !== 'starting') break;
        await new Promise(r => setTimeout(r, 2000));
      }
      check(st && st.state === 'ready', `it is running: ${st ? mcpStateText(st) + (st.detail ? ' ' + st.detail : '') : 'gone'}`);
      if (st && st.state === 'ready') {
        const names = st.tools.map(t => t.name);
        check(names.includes('echo') && names.includes('get-sum'), `its tools are listed (${names.length}): ${names.slice(0, 6).join(', ')}…`);
        const echo = st.tools.find(t => t.name === 'echo');
        check(echo && echo.read_only === true && echo.input_schema && echo.input_schema.type === 'object', 'with their schema and readOnlyHint');

        const e = await call(NAME, 'echo', { message: 'round 9' });
        check(e.status === 200 && e.data.text === 'Echo: round 9', `a call round-trips: "${e.data.text || e.data.error}" in ${e.data.ms} ms`);
        const sum = await call(NAME, 'get-sum', { a: 2, b: 40 });
        check(sum.status === 200 && /42/.test(sum.data.text), `another: "${sum.data.text || sum.data.error}"`);
        const env = await call(NAME, 'get-env', {});
        check(env.status === 200 && !/GOBBONET|ACCESS_SECRET|LLM_API_KEY/.test(env.data.text) && /PATH/i.test(env.data.text),
          'the program sees PATH and its like, and no GOBBONET_ variable: ' + Object.keys((() => { try { return JSON.parse(env.data.text); } catch (_) { return {}; } })()).join(', '));
        const img = await call(NAME, 'get-tiny-image', {});
        check(img.status === 200 && /\[image \(image\/png, .*\) not shown\]/.test(img.data.text) && !/iVBOR/.test(img.data.text), 'an image is named, not sent as text');
        const bad = await call(NAME, 'echo', {});
        check(bad.status === 200 && bad.data.is_error === true, 'arguments the tool rejects come back as its error, not a crash');
        const none = await call(NAME, 'rm-rf', {});
        check(none.status === 404 && none.data.kind === 'unknown_tool', `a tool it does not list is refused: ${none.status}`);
      }

      const off = await req('POST', '/mcp/servers', { action: 'disable', name: NAME });
      const offSt = (off.data.servers || []).find(s => s.name === NAME);
      check(off.status === 200 && offSt && offSt.state === 'off', 'SWITCH OFF stops it');
      const after = await call(NAME, 'echo', { message: 'x' });
      check(after.status === 409 && after.data.kind === 'disabled', `and a call to it is refused without starting it: ${after.status}`);
    } finally {
      const gone = await req('POST', '/mcp/servers', { action: 'remove', name: NAME });
      check(gone.status === 200 && !(gone.data.servers || []).some(s => s.name === NAME), 'removed from config.toml again');
      try { await loadMCPPanel(); } catch (_) {}
    }
  }

  log('INFO', '--- By hand ---');
  log('INFO', '1. CONFIG > Advanced > MCP Servers > + ADD SERVER: PASTE A SETUP (JSON) from a server\'s instructions, check the fields, SAVE SERVER, then SWITCH ON and CHECK TOOLS.');
  log('INFO', '2. From your phone: the box shows only SWITCH OFF and CHECK TOOLS, and says where to go for the rest.');
  log('INFO', '3. End the server\'s process (Task Manager, or kill): the box says "Not working" with its last words, and the next CHECK TOOLS a few seconds later starts it again.');
  log('INFO', '4. gobbonet doctor has an MCP SERVERS section; each server\'s output is in mcp-<name>.log beside llama-server.log.');
  log('INFO', '5. Windows: try a server whose command is npx (npx.cmd); it should start like any other.');
  return done();
})();
