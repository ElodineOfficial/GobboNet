/**
 * Item 9 — cast reordering.
 *
 * Executes the REAL moveCastEntry / refreshMoveButtons / moveColumnHtml from
 * js/15-cards.js and the REAL renderCardGrid / renderPersonaGrid, in a minimal
 * fake DOM whose innerHTML setter parses the generated markup back into nodes.
 *
 * That parse is the point: the tests drive the grid by finding the arrow in the
 * rendered HTML and evaluating its actual onclick attribute, so a wrong
 * argument order or a broken attribute fails here rather than in a browser.
 */
import fs from 'fs';
import vm from 'vm';

import { fileURLToPath } from 'node:url';
const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '');
const CARDS = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
const PERSONAS = fs.readFileSync(ROOT + '/js/17-personas.js', 'utf8');

// Pull the reorder block + renderCardGrid out of 15-cards.js. The rest of the
// file is settings and the card editor and wants a much larger fake DOM.
const cardsBlock = CARDS.slice(
  CARDS.indexOf('/* ── Cast ordering'),
  CARDS.indexOf('function activateCard(')
);
// renderPersonaGrid + movePersona out of 17-personas.js.
const personaBlock = PERSONAS.slice(
  PERSONAS.indexOf('function renderPersonaGrid()'),
  PERSONAS.indexOf('function createPersona()')
);

let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log('  \u2713 ' + label); }
  else { fail++; console.log('  \u2717 ' + label); }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b),
  label + (JSON.stringify(a) === JSON.stringify(b) ? '' : `  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`));

/* ── Fake DOM ─────────────────────────────────────────────────────────────
   Only what the reorder path touches: a grid with children + insertBefore,
   rows that can find their arrows, buttons that carry disabled/dataset/focus. */

const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
                     .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
                     .replace(/&amp;/g, '&');

function parseButtons(rowHtml, row) {
  const out = [];
  for (const m of rowHtml.matchAll(/<button\b([^>]*)>/g)) {
    const attrs = {};
    for (const a of m[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) attrs[a[1]] = a[2];
    const bare = m[1].replace(/[a-zA-Z-]+="[^"]*"/g, '');
    out.push({
      attrs,
      dataset: { move: attrs['data-move'] },
      disabled: /\bdisabled\b/.test(bare),
      isConnected: true,
      parentNode: row,
      focus() { row._grid._focused = this; },
    });
  }
  return out;
}

function makeGrid(id) {
  const grid = {
    id,
    children: [],
    _focused: null,
    set innerHTML(html) {
      // Rows are the top-level .card-item divs.
      const chunks = html.split(/(?=<div class="card-item)/).filter(c => c.includes('card-item'));
      grid.children = chunks.map(chunk => {
        const row = { _html: chunk, _grid: grid, _buttons: [] };
        row._buttons = parseButtons(chunk, row);
        row.querySelector = sel => {
          const want = /\[data-move="(\w+)"\]/.exec(sel);
          if (!want) return null;
          return row._buttons.find(b => b.dataset.move === want[1]) || null;
        };
        return row;
      });
    },
    get innerHTML() { return grid.children.map(r => r._html).join(''); },
    insertBefore(node, ref) {
      const cur = grid.children.indexOf(node);
      if (cur !== -1) grid.children.splice(cur, 1);
      const at = ref ? grid.children.indexOf(ref) : grid.children.length;
      grid.children.splice(at === -1 ? grid.children.length : at, 0, node);
      return node;
    },
  };
  // nextSibling is read off the pre-move snapshot in moveCastEntry.
  Object.defineProperty(grid, '_ns', { value: true });
  return grid;
}

function attachSiblings(grid) {
  grid.children.forEach((row, i) => {
    Object.defineProperty(row, 'nextSibling', {
      configurable: true,
      get: () => grid.children[grid.children.indexOf(row) + 1] || null,
    });
  });
}

function build(cards, personas) {
  const grids = { 'card-grid': makeGrid('card-grid'), 'persona-grid': makeGrid('persona-grid') };
  const saves = [];
  const ctx = {
    console,
    state: {
      characterCards: cards.map(c => ({ ...c })),
      personaCards: personas.map(p => ({ ...p })),
      activeCardId: cards[0] && cards[0].id,
      activePersonaId: personas[0] && personas[0].id,
    },
    document: { getElementById: id => grids[id] || null },
    saveState: () => saves.push(1),
    renderAvatar: (a, n) => `<span>${(n || '?')[0]}</span>`,
    escapeHtml: s => String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;'),
    DEFAULT_PERSONA: {},
  };
  ctx.escapeJsString = s => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  ctx.escapeJsAttr = s => ctx.escapeHtml(ctx.escapeJsString(s));
  ctx.renderMessages = () => {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(cardsBlock + '\n' + personaBlock, ctx);
  return { ctx, grids, saves };
}

/* Render, then click an arrow by evaluating the attribute the renderer wrote. */
function clickArrow(env, gridId, rowIdx, dir) {
  const grid = env.grids[gridId];
  attachSiblings(grid);
  const btn = grid.children[rowIdx].querySelector(`[data-move="${dir}"]`);
  if (!btn) return null;
  const src = decode(btn.attrs.onclick);
  const fn = vm.runInContext(`(function(event){ ${src} })`, env.ctx);
  fn.call(btn, { stopPropagation() {} });
  return btn;
}

const names = grid => grid.children.map(r => /card-name">([^<]*)</.exec(r._html)[1]);
const caps = grid => grid.children.map(r => {
  const u = r.querySelector('[data-move="up"]');
  const d = r.querySelector('[data-move="down"]');
  return (u && u.disabled ? 'U' : '-') + (d && d.disabled ? 'D' : '-');
});

const CARDS4 = [
  { id: 'a', name: 'Alpha', writingStyle: '' },
  { id: 'b', name: 'Bravo', writingStyle: '' },
  { id: 'c', name: 'Charlie', writingStyle: '' },
  { id: 'd', name: 'Delta', writingStyle: '' },
];
const PERS3 = [
  { id: 'p1', name: 'Pip', description: '', injectionFrequency: 5 },
  { id: 'p2', name: 'Quill', description: '', injectionFrequency: 5 },
  { id: 'p3', name: 'Rook', description: '', injectionFrequency: 5 },
];

console.log('\n=== A. ordering mechanics (characters) ===');
{
  const env = build(CARDS4, PERS3);
  env.ctx.renderCardGrid();
  eq(names(env.grids['card-grid']), ['Alpha', 'Bravo', 'Charlie', 'Delta'], 'renders in array order');

  clickArrow(env, 'card-grid', 2, 'up');
  eq(env.ctx.state.characterCards.map(c => c.name), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'move up: array spliced');
  eq(names(env.grids['card-grid']), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'move up: DOM follows array');
  eq(env.saves.length, 1, 'move up: saved once');

  clickArrow(env, 'card-grid', 0, 'down');
  eq(env.ctx.state.characterCards.map(c => c.name), ['Charlie', 'Alpha', 'Bravo', 'Delta'], 'move down: array spliced');
  eq(names(env.grids['card-grid']), ['Charlie', 'Alpha', 'Bravo', 'Delta'], 'move down: DOM follows array');
}

console.log('\n=== B. refusals at the ends ===');
{
  const env = build(CARDS4, PERS3);
  env.ctx.renderCardGrid();
  const before = env.ctx.state.characterCards.map(c => c.name);

  const topUp = clickArrow(env, 'card-grid', 0, 'up');
  ok(topUp.disabled, 'top row: up arrow renders disabled');
  eq(env.ctx.state.characterCards.map(c => c.name), before, 'top row: up is a no-op');

  const botDown = clickArrow(env, 'card-grid', 3, 'down');
  ok(botDown.disabled, 'bottom row: down arrow renders disabled');
  eq(env.ctx.state.characterCards.map(c => c.name), before, 'bottom row: down is a no-op');

  eq(env.saves.length, 0, 'refused moves do not write state');

  env.ctx.moveCard('nope', -1, null);
  eq(env.ctx.state.characterCards.map(c => c.name), before, 'unknown id is a no-op');
  eq(env.saves.length, 0, 'unknown id does not write state');
}

console.log('\n=== C. end-caps track the live positions ===');
{
  const env = build(CARDS4, PERS3);
  env.ctx.renderCardGrid();
  eq(caps(env.grids['card-grid']), ['U-', '--', '--', '-D'], 'initial caps: top locked up, bottom locked down');

  clickArrow(env, 'card-grid', 3, 'up');           // Delta to index 2
  eq(caps(env.grids['card-grid']), ['U-', '--', '--', '-D'], 'caps recomputed after a move');

  clickArrow(env, 'card-grid', 2, 'up');           // Delta to 1
  clickArrow(env, 'card-grid', 1, 'up');           // Delta to 0
  eq(names(env.grids['card-grid']), ['Delta', 'Alpha', 'Bravo', 'Charlie'], 'three moves walk a card to the top');
  eq(caps(env.grids['card-grid']), ['U-', '--', '--', '-D'], 'caps still correct at the top');
}

console.log('\n=== D. in-place move matches a full re-render ===');
{
  // The divergence guard. moveCastEntry moves a node instead of re-rendering,
  // so the two paths must agree or the grid drifts from state.
  const env = build(CARDS4, PERS3);
  env.ctx.renderCardGrid();
  clickArrow(env, 'card-grid', 3, 'up');
  clickArrow(env, 'card-grid', 1, 'down');
  const afterMoves = names(env.grids['card-grid']);
  const capsAfterMoves = caps(env.grids['card-grid']);

  env.ctx.renderCardGrid();                        // full rebuild from state
  eq(names(env.grids['card-grid']), afterMoves, 'row order identical after a full re-render');
  eq(caps(env.grids['card-grid']), capsAfterMoves, 'end-caps identical after a full re-render');
}

console.log('\n=== E. DOM drift falls back to a full render ===');
{
  const env = build(CARDS4, PERS3);
  env.ctx.renderCardGrid();
  attachSiblings(env.grids['card-grid']);
  const btn = env.grids['card-grid'].children[2].querySelector('[data-move="up"]');
  env.grids['card-grid'].children.pop();           // desync the DOM from state
  env.ctx.moveCard('c', -1, btn);
  eq(env.ctx.state.characterCards.map(c => c.name), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'array still spliced');
  eq(names(env.grids['card-grid']), ['Alpha', 'Charlie', 'Bravo', 'Delta'], 'grid rebuilt from state, drift discarded');
}

console.log('\n=== F. focus survives the move ===');
{
  const env = build(CARDS4, PERS3);
  env.ctx.renderCardGrid();
  const b1 = clickArrow(env, 'card-grid', 2, 'up');
  ok(env.grids['card-grid']._focused === b1, 'focus stays on the clicked arrow');

  const b2 = clickArrow(env, 'card-grid', 1, 'up');   // Bravo reaches the top
  ok(b2.disabled, 'arrow disables on reaching the end');
  ok(env.grids['card-grid']._focused &&
     env.grids['card-grid']._focused.dataset.move === 'down',
     'focus hands off to the partner arrow instead of dropping to <body>');
}

console.log('\n=== G. a list of one has no reorder column ===');
{
  const env = build([{ id: 'a', name: 'Alpha', writingStyle: '' }], PERS3);
  env.ctx.renderCardGrid();
  ok(!env.grids['card-grid'].children[0].querySelector('[data-move="up"]'), 'single card: no arrows rendered');
  ok(env.grids['card-grid'].children[0]._html.includes('card-avatar'), 'single card: row otherwise unchanged');
}

console.log('\n=== H. personas use the same engine ===');
{
  const env = build(CARDS4, PERS3);
  env.ctx.renderPersonaGrid();
  eq(names(env.grids['persona-grid']), ['Pip', 'Quill', 'Rook'], 'persona grid renders in array order');

  clickArrow(env, 'persona-grid', 2, 'up');
  eq(env.ctx.state.personaCards.map(p => p.name), ['Pip', 'Rook', 'Quill'], 'persona move up: array spliced');
  eq(names(env.grids['persona-grid']), ['Pip', 'Rook', 'Quill'], 'persona move up: DOM follows');
  eq(caps(env.grids['persona-grid']), ['U-', '--', '-D'], 'persona end-caps correct');

  clickArrow(env, 'persona-grid', 0, 'up');
  eq(env.ctx.state.personaCards.map(p => p.name), ['Pip', 'Rook', 'Quill'], 'persona top row up is a no-op');

  // Reordering personas must not disturb characters and vice versa.
  eq(env.ctx.state.characterCards.map(c => c.name), ['Alpha', 'Bravo', 'Charlie', 'Delta'], 'character order untouched by persona moves');
}

console.log('\n=== I. persona empty / single list ===');
{
  const env = build(CARDS4, []);
  env.ctx.renderPersonaGrid();
  eq(env.grids['persona-grid'].children.length, 0, 'no personas: empty-state message, no rows');

  const env2 = build(CARDS4, [{ id: 'p1', name: 'Pip', description: '' }]);
  env2.ctx.renderPersonaGrid();
  ok(!env2.grids['persona-grid'].children[0].querySelector('[data-move="up"]'), 'single persona: no arrows rendered');
}

console.log('\n=== J. hostile id and name survive the new markup ===');
{
  const hostile = [
    { id: 'x" onmouseover="alert(1)', name: '<img src=x onerror=alert(1)>', writingStyle: '' },
    { id: 'b', name: 'Bravo', writingStyle: '' },
  ];
  const env = build(hostile, PERS3);
  env.ctx.renderCardGrid();
  const html = env.grids['card-grid'].children[0]._html;
  // The attribute parser stops at the first raw quote, exactly like a browser.
  // If escaping failed, the onclick would be truncated and a stray attribute
  // would appear alongside it.
  const up = env.grids['card-grid'].children[0].querySelector('[data-move="up"]');
  ok(up.attrs.onmouseover === undefined, 'hostile id does not become a second attribute');
  ok(decode(up.attrs.onclick).includes('alert(1)\',-1,this)'),
     'onclick carries the whole id through to the closing paren');
  ok(!html.includes('<img src=x'), 'hostile name does not reach the DOM as a tag');
  ok(html.includes('aria-label="Move &lt;img'), 'hostile name is escaped inside aria-label');

  // And it still moves.
  clickArrow(env, 'card-grid', 1, 'up');
  eq(env.ctx.state.characterCards.map(c => c.id), ['b', 'x" onmouseover="alert(1)'], 'hostile id still reorders correctly');
}

console.log('\n=== K. assumption guard: import still appends ===');
{
  // The whole design rests on merge-import landing new entries at the end
  // rather than interleaving them. If that ever changes, ordering breaks and
  // this is the cheapest place to notice.
  const DATA = fs.readFileSync(ROOT + '/js/21-data.js', 'utf8');
  ok(DATA.includes('state.characterCards = [...state.characterCards, ...newCards]'),
     'card import appends (js/21-data.js)');
  ok(DATA.includes('state.personaCards = [...state.personaCards, ...newPersonas]'),
     'persona import appends (js/21-data.js)');
  const PERSIST = fs.readFileSync(ROOT + '/js/05-persistence.js', 'utf8');
  ok(/characterCards: state\.characterCards/.test(PERSIST) && /personaCards: state\.personaCards/.test(PERSIST),
     'both arrays still persist whole, so array order round-trips');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
