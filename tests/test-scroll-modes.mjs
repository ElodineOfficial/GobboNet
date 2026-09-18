/**
 * Auto-scroll modes — roadmap item 5, "make smart scrolling optional".
 *
 * "Smart" is a guess about intent, and a guess can be wrong in two opposite
 * directions. It can hold on too long, dragging the viewport around while you
 * read something further up. It can also let go too easily: the touch handler
 * unfollows on ANY touch during generation, which is deliberate, and which
 * also means a tap to dismiss the keyboard stops a follow you wanted. So there
 * are three values, not a checkbox — the two failure directions plus the thing
 * in the middle.
 *
 * WHAT MATTERS MOST HERE
 * ----------------------
 * Section A: the default cannot move. Every install has no stored value, and
 * an absent or nonsense one has to resolve to 'smart' or people boot into a
 * scrolling behaviour nobody chose.
 *
 * Section D: the end-of-stream settle. renderMessages() rebuilds the thread
 * with innerHTML, which resets scrollTop to 0. The old code handled that for
 * the follow case and did *nothing* for the not-following case — and "nothing"
 * is not "leave them where they were reading", because the rebuild has already
 * moved them to the top. That was survivable when it needed the user to have
 * scrolled up mid-stream. With 'off' it would fire on every single generation,
 * which is how it got noticed.
 *
 * This drives the real functions from js/14-scroll.js against a fake scroll
 * container, so what is asserted is what the container's scrollTop actually
 * ends up as.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/14-scroll.js', 'utf8');

const slice = (from, to) => {
  const a = SRC.indexOf(from);
  const b = to ? SRC.indexOf(to) : SRC.length;
  if (a < 0 || b < 0 || b <= a) {
    console.error('could not locate ' + JSON.stringify(from) + ' in js/14-scroll.js');
    process.exit(1);
  }
  return SRC.slice(a, b);
};

// Everything from the mode helper down to goHome(); the rest of the file is
// rendering and needs the whole app.
const BLOCK = slice('const AUTO_SCROLL_MODES', 'function goHome');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

/* ================================================================
   A fake scroll container

   scrollTop clamps the way a real one does: assigning past the end lands at
   scrollHeight - clientHeight, and a negative value lands at 0. Several
   assertions below are about exactly that clamping, so a fake that stored
   whatever it was handed would pass tests a browser would fail.
================================================================ */
function makeContainer({ scrollHeight = 5000, clientHeight = 800, scrollTop = 4200 } = {}) {
  const el = {
    id: 'messages',
    dataset: {},
    scrollHeight, clientHeight,
    offsetTop: 0, offsetHeight: clientHeight,
    style: {},
    _handlers: {},
    _scrollWrites: 0,
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(t, fn) { (this._handlers[t] = this._handlers[t] || []).push(fn); },
    querySelector: () => null,
    querySelectorAll: () => [],
    fire(t, ev) { (this._handlers[t] || []).forEach(fn => fn(ev || {})); },
  };
  let _top = scrollTop;
  Object.defineProperty(el, 'scrollTop', {
    get: () => _top,
    set: (v) => {
      el._scrollWrites++;
      _top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight));
    },
  });
  return el;
}

function build({ mode, container, generating = false } = {}) {
  const c = container || makeContainer();
  const btn = { id: 'follow-bottom-btn', style: {}, _visible: false,
    classList: { toggle(cls, on) { if (cls === 'visible') btn._visible = !!on; } } };
  const chat = { id: 'chat', clientHeight: c.clientHeight };
  const els = { messages: c, 'follow-bottom-btn': btn, chat };

  const rafQueue = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    state: { settings: mode === undefined ? {} : { autoScroll: mode }, activeThreadId: 't1' },
    isGenerating: generating,
    scrollPinnedToBottom: true,
    getActiveThread: () => ({ id: 't1', messages: [] }),
    document: { getElementById: (id) => els[id] || null },
    window: { addEventListener() {} },
    requestAnimationFrame: (fn) => { rafQueue.push(fn); return rafQueue.length; },
    Math, Date, JSON, Object, Array, String, Number,
    // The real one lives in js/13-dashboard.js and is the FORCE variant.
    scrollToBottom: (opts) => {
      ctx._forced = (ctx._forced || 0) + 1;
      ctx._lastOpts = opts || {};
      ctx.requestAnimationFrame(() => ctx.requestAnimationFrame(() => {
        if (opts && opts.respectPin && !vm.runInContext('scrollPinnedToBottom', ctx)) return;
        c.scrollTop = c.scrollHeight;
      }));
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(BLOCK, ctx);

  const get = (expr) => vm.runInContext(expr, ctx);
  const set = (expr) => vm.runInContext(expr, ctx);
  // Two passes, because the code under test schedules a rAF from inside a rAF.
  const flush = () => { for (let i = 0; i < 4 && rafQueue.length; i++) {
    const batch = rafQueue.splice(0, rafQueue.length); batch.forEach(fn => fn());
  } };
  // updateFollowButton() treats a thread-id change as freshly-pinned, and a
  // fresh context has never seen this thread, so its FIRST call always re-pins.
  // In the app that call happens during render, long before any gesture; here
  // it has to be done on purpose or every gesture assertion is fighting it.
  // (The scroll and touch handlers both end by calling updateFollowButton.)
  const prime = () => ctx.updateFollowButton();
  return { ctx, c, btn, get, set, flush, prime, pinned: () => get('scrollPinnedToBottom') };
}

/* ================================================================
   A. THE DEFAULT DOES NOT MOVE
================================================================ */
console.log('\n=== A. absent or nonsense resolves to smart ===');
{
  eq(build({}).ctx.autoScrollMode(), 'smart', 'an empty settings object is smart');
  eq(build({ mode: undefined }).ctx.autoScrollMode(), 'smart', 'an absent value is smart');
  for (const bad of [null, '', 'SMART', 'Smart', 'on', true, 1, 'never', {}]) {
    eq(build({ mode: bad }).ctx.autoScrollMode(), 'smart',
       `${JSON.stringify(bad)} resolves to smart`);
  }
  for (const good of ['smart', 'always', 'off']) {
    eq(build({ mode: good }).ctx.autoScrollMode(), good, `"${good}" is honoured`);
  }
}

/* ================================================================
   B. THE STREAMING TICK
================================================================ */
console.log('\n=== B. what a chunk does to the viewport ===');
{
  // Smart, pinned: chases the bottom.
  let h = build({ mode: 'smart', container: makeContainer({ scrollTop: 4200 }) });
  h.ctx.autoScrollToBottom(); h.flush();
  eq(h.c.scrollTop, 4200, 'smart + pinned lands at the bottom');

  // Smart, unpinned: leaves the viewport alone.
  h = build({ mode: 'smart', container: makeContainer({ scrollTop: 1000 }) });
  h.set('scrollPinnedToBottom = false');
  h.ctx.autoScrollToBottom(); h.flush();
  eq(h.c.scrollTop, 1000, 'smart + unpinned does not move');
  eq(h.c._scrollWrites, 0, 'and does not even write scrollTop');

  // Off: never moves, pinned or not.
  for (const pin of [true, false]) {
    h = build({ mode: 'off', container: makeContainer({ scrollTop: 1000 }) });
    if (!pin) h.set('scrollPinnedToBottom = false');
    h.ctx.autoScrollToBottom(); h.flush();
    eq(h.c.scrollTop, 1000, `off does not move the viewport (pinned=${pin})`);
    eq(h.c._scrollWrites, 0, '  ...and writes nothing');
  }

  // Always: chases even when the pin says otherwise, and without respectPin --
  // re-checking the pin two frames later is exactly the letting-go this mode
  // exists to prevent.
  h = build({ mode: 'always', container: makeContainer({ scrollTop: 1000 }) });
  h.set('scrollPinnedToBottom = false');
  h.ctx.autoScrollToBottom(); h.flush();
  eq(h.c.scrollTop, 4200, 'always lands at the bottom even when unpinned');
  ok(!h.ctx._lastOpts.respectPin, 'and does not pass respectPin');
}

/* ================================================================
   C. UNFOLLOW GESTURES
================================================================ */
console.log('\n=== C. scrolling up and touching ===');
{
  // Smart: scrolling away from the bottom unpins.
  let h = build({ mode: 'smart' });
  h.ctx.attachScrollPinTracking();
  h.prime();
  h.c.scrollTop = 1000;
  h.c.fire('scroll');
  ok(!h.pinned(), 'smart: scrolling up unpins');
  h.c.scrollTop = h.c.scrollHeight;
  h.c.fire('scroll');
  ok(h.pinned(), 'and scrolling back down re-pins');

  // Always: scrolling up does not unpin.
  h = build({ mode: 'always' });
  h.ctx.attachScrollPinTracking();
  h.prime();
  h.c.scrollTop = 1000;
  h.c.fire('scroll');
  ok(h.pinned(), 'always: scrolling up does not unpin');

  // Touch during generation is the mobile unfollow.
  h = build({ mode: 'smart', generating: true });
  h.ctx.attachScrollPinTracking();
  h.prime();
  h.c.fire('touchstart');
  ok(!h.pinned(), 'smart: one touch during generation stops following');

  h = build({ mode: 'always', generating: true });
  h.ctx.attachScrollPinTracking();
  h.prime();
  h.c.fire('touchstart');
  ok(h.pinned(), 'always: a touch does not stop it');

  h = build({ mode: 'off', generating: true });
  h.ctx.attachScrollPinTracking();
  h.prime();
  h.c.fire('touchstart');
  ok(h.pinned(), 'off: a touch changes nothing, because nothing was following');

  // Outside generation a touch is just a touch, in every mode.
  h = build({ mode: 'smart', generating: false });
  h.ctx.attachScrollPinTracking();
  h.prime();
  h.c.fire('touchstart');
  ok(h.pinned(), 'a touch outside generation never unfollows');
}

/* ================================================================
   D. THE END-OF-STREAM SETTLE

   renderMessages() has just reset scrollTop to 0. The anchor was taken before
   that. What happens next is the whole of this section.
================================================================ */
console.log('\n=== D. settling after the rebuild ===');
{
  // The anchor measures from the BOTTOM, because everything that changes in
  // the rebuild changes at the end of the thread.
  let h = build({ mode: 'smart', container: makeContainer({ scrollHeight: 5000, clientHeight: 800, scrollTop: 1000 }) });
  let anchor = h.ctx.captureScrollAnchor();
  eq(anchor.fromBottom, 3200, 'the anchor is the distance from the bottom');
  ok(anchor.following === true, 'and carries the follow state');

  // Smart + following: land at the settled bottom.
  h = build({ mode: 'smart', container: makeContainer({ scrollTop: 4200 }) });
  anchor = h.ctx.captureScrollAnchor();
  h.c.scrollTop = 0;                       // what the innerHTML rebuild did
  h.set('scrollPinnedToBottom = false');   // and the scroll event it fired
  h.ctx.settleScrollAfterGeneration(anchor); h.flush();
  eq(h.c.scrollTop, 4200, 'smart + was following: lands at the bottom');
  ok(h.pinned(), 'and the pin the rebuild clobbered is restored');

  // Smart + NOT following: put the reading position back. Doing nothing here
  // leaves the user at the top, which is what used to happen.
  h = build({ mode: 'smart', container: makeContainer({ scrollTop: 1200 }) });
  anchor = h.ctx.captureScrollAnchor();
  h.set('scrollPinnedToBottom = false');
  anchor.following = false;
  h.c.scrollTop = 0;
  h.ctx.settleScrollAfterGeneration(anchor); h.flush();
  eq(h.c.scrollTop, 1200, 'smart + was reading: put back where they were, NOT at the top');

  // The rebuild usually changes the height. Anchoring from the bottom keeps
  // the same text under the eye; anchoring from the top would not.
  h = build({ mode: 'smart', container: makeContainer({ scrollHeight: 5000, scrollTop: 1200 }) });
  anchor = h.ctx.captureScrollAnchor();   // fromBottom = 3000
  anchor.following = false;
  h.c.scrollHeight = 5600;                // the final markdown is taller
  h.c.scrollTop = 0;
  h.ctx.settleScrollAfterGeneration(anchor); h.flush();
  eq(h.c.scrollTop, 1800, 'a taller final render keeps the same distance from the bottom');

  // Off: never lands at the bottom on its own, even if the user was pinned.
  h = build({ mode: 'off', container: makeContainer({ scrollTop: 4200 }) });
  anchor = h.ctx.captureScrollAnchor();
  ok(anchor.following === true, 'off: the user was at the bottom when it started');
  h.c.scrollTop = 0;
  h.ctx.settleScrollAfterGeneration(anchor); h.flush();
  eq(h.c.scrollTop, 4200, 'off: the position is restored...');
  ok(h.ctx._forced === undefined, '...by restoring the anchor, not by a forced scroll to bottom');

  // Off, reading history: same rule.
  h = build({ mode: 'off', container: makeContainer({ scrollTop: 900 }) });
  anchor = h.ctx.captureScrollAnchor();
  h.c.scrollTop = 0;
  h.ctx.settleScrollAfterGeneration(anchor); h.flush();
  eq(h.c.scrollTop, 900, 'off: reading position survives the rebuild');

  // Always: lands at the bottom whatever the captured state said, because it
  // never stopped following.
  h = build({ mode: 'always', container: makeContainer({ scrollTop: 1000 }) });
  anchor = h.ctx.captureScrollAnchor();
  anchor.following = false;
  h.c.scrollTop = 0;
  h.set('scrollPinnedToBottom = false');
  h.ctx.settleScrollAfterGeneration(anchor); h.flush();
  eq(h.c.scrollTop, 4200, 'always: settles at the bottom regardless');

  // The old boolean call shape must still work, in case anything still uses it.
  h = build({ mode: 'smart', container: makeContainer({ scrollTop: 0 }) });
  h.ctx.settleScrollAfterGeneration(true); h.flush();
  eq(h.c.scrollTop, 4200, 'the legacy boolean argument still means "was following"');

  // A restore can never land outside the scrollable range.
  h = build({ mode: 'off', container: makeContainer({ scrollHeight: 5000, scrollTop: 1200 }) });
  anchor = h.ctx.captureScrollAnchor();
  h.c.scrollHeight = 1000;                 // the thread got much shorter
  h.c.scrollTop = 0;
  h.ctx.settleScrollAfterGeneration(anchor); h.flush();
  ok(h.c.scrollTop >= 0, 'a shorter final render cannot produce a negative scrollTop');
}

/* ================================================================
   E. THE JUMP-TO-LATEST BUTTON

   In 'off' this is the ONLY way down, so its visibility rule is the
   difference between "optional" and "broken".
================================================================ */
console.log('\n=== E. the follow button ===');
{
  // Smart, unpinned, content below the fold: offered.
  //
  // Primed with one call first: updateFollowButton treats a thread-id change
  // as freshly-pinned (a switch lands the viewport at the end), and a fresh
  // context has no remembered id, so the very first call always re-pins. That
  // is real behaviour, not a quirk of the fake -- it is what stops the button
  // flashing on every thread switch.
  let h = build({ mode: 'smart', container: makeContainer({ scrollTop: 1000 }) });
  h.ctx.updateFollowButton();              // prime the remembered thread id
  ok(h.pinned(), 'a first paint on a new thread counts as pinned');
  h.set('scrollPinnedToBottom = false');
  h.ctx.updateFollowButton();
  ok(h.btn._visible, 'smart + unpinned + far from the bottom: offered');

  // Smart, pinned: nothing to jump to.
  h = build({ mode: 'smart', container: makeContainer({ scrollTop: 4200 }) });
  h.ctx.updateFollowButton();
  ok(!h.btn._visible, 'smart + pinned: hidden');

  // THE ONE THAT MATTERS. In 'off' the viewport never moves, so no scroll
  // event ever fires and the pin stays stuck at true from when the reply
  // started. Reading the raw pin would hide the button for the whole reply:
  // no auto-scroll AND no way down.
  h = build({ mode: 'off', container: makeContainer({ scrollTop: 1000 }) });
  ok(h.pinned(), 'off: the stale pin still says "following"');
  h.ctx.updateFollowButton();
  ok(h.btn._visible, 'and the button is offered anyway, because distance decides in off');

  // Still hidden when there is genuinely nothing below the fold.
  h = build({ mode: 'off', container: makeContainer({ scrollTop: 4200 }) });
  h.ctx.updateFollowButton();
  ok(!h.btn._visible, 'off + already at the bottom: hidden');

  // Always: the viewport is glued to the bottom, so there is never anywhere
  // to jump to.
  h = build({ mode: 'always', container: makeContainer({ scrollTop: 1000 }) });
  h.ctx.updateFollowButton();
  h.set('scrollPinnedToBottom = false');
  h.ctx.updateFollowButton();
  ok(!h.btn._visible, 'always: never offered');

  // Tapping it lands at the bottom in every mode -- it is user-initiated.
  for (const mode of ['smart', 'always', 'off']) {
    h = build({ mode, container: makeContainer({ scrollTop: 500 }) });
    h.set('scrollPinnedToBottom = false');
    h.ctx.followToBottom(); h.flush();
    eq(h.c.scrollTop, 4200, `${mode}: tapping the button lands at the bottom`);
    ok(h.pinned(), `  ...and re-pins`);
  }
}

/* ================================================================
   F. WIRING
================================================================ */
console.log('\n=== F. wiring ===');
{
  const html = fs.readFileSync(ROOT + '/chat.html', 'utf8');
  const cards = fs.readFileSync(ROOT + '/js/15-cards.js', 'utf8');
  const state = fs.readFileSync(ROOT + '/js/04-state.js', 'utf8');
  const chat = fs.readFileSync(ROOT + '/js/10-chat.js', 'utf8');

  ok(/name="set-auto-scroll"/.test(html), 'the CONFIG modal has the picker');
  for (const v of ['smart', 'always', 'off']) {
    ok(new RegExp(`name="set-auto-scroll" value="${v}"`).test(html), `  with the ${v} option`);
  }
  ok(/autoScroll:\s*'smart'/.test(state), "the default in DEFAULT_SETTINGS is 'smart'");
  ok(/autoScrollMode\(\)/.test(cards), 'openSettings picks the radio through autoScrollMode()');
  ok(/AUTO_SCROLL_MODES\.indexOf/.test(cards), 'and saveSettings validates before storing');

  // Every settle call site must capture BEFORE renderMessages(), or the anchor
  // describes the top of the thread rather than where the user was. Located by
  // index rather than by splitting the file, because renderMessages() is
  // called from several places that have nothing to do with settling.
  const settleSites = [...chat.matchAll(/settleScrollAfterGeneration\(/g)].map(m => m.index);
  eq(settleSites.length, 3, 'there are three settle sites');
  for (const idx of settleSites) {
    const render = chat.lastIndexOf('renderMessages();', idx);
    const capture = chat.lastIndexOf('captureScrollAnchor()', idx);
    const line = chat.slice(0, idx).split('\n').length;
    ok(capture >= 0 && render >= 0 && capture < render,
       `the settle at line ${line} captures its anchor before the rebuild`,
       `capture@${capture} render@${render}`);
  }
  ok(!/settleScrollAfterGeneration\(captureScrollAnchor\(\)\)/.test(chat),
     'and none captures it inline after the rebuild');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
