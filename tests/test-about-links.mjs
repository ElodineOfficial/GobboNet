/**
 * ABOUT links out — roadmap 1.7.7 item #3.
 *
 * Two links (MODS, DISCORD) and a placeholder for checking for updates. Small,
 * but three things about it are worth holding:
 *
 *   A. The addresses are exactly the ones the maintainer gave. A typo in an
 *      invite link fails silently — it opens a "this invite is invalid" page
 *      for every user and nothing in the app notices.
 *   B. Opening one cannot hand anything back. noopener (no window.opener for
 *      the new tab) and noreferrer (no Referer: on a LAN that is the PC's
 *      private address).
 *   C. Nothing contacts these sites on its own. PRIVATE BY DESIGN promises
 *      that the only network calls are ones you ask for, so the addresses
 *      live in click handlers and nowhere a script could reach on its own.
 *      CHECK FOR UPDATES was a do-nothing placeholder here until 1.8.0; it is
 *      real now, lives under THIS BUILD, and asks for a check only when it
 *      is pressed (tests/test-update-button.mjs has the rest).
 *
 * D pins the visual rule: the box is a copy of YOUR DATA, not a new design.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const HTML = fs.readFileSync(ROOT + '/chat.html', 'utf8');
const SCHED_SRC = fs.readFileSync(ROOT + '/js/22-scheduler.js', 'utf8');
const JS_FILES = fs.readdirSync(ROOT + '/js').filter(f => f.endsWith('.js'));

const MODS_URL = 'https://goblincorps.com/gobbonet_extras';
const DISCORD_URL = 'https://discord.gg/rcmN8uEbaa';

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  ✓ ' + l); }
  else { fail++; console.log('  ✗ ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

// The ABOUT modal, from its backdrop to the next script tag.
const aboutStart = HTML.indexOf('id="about-modal"');
const ABOUT = aboutStart < 0 ? '' : HTML.slice(aboutStart, HTML.indexOf('<script', aboutStart));
const tagById = (id) => {
  const m = new RegExp('<button[^>]*\\bid="' + id + '"[^>]*>([^<]*)</button>').exec(ABOUT);
  return m ? { tag: m[0], text: m[1] } : null;
};

/* ================================================================
   A. THE ADDRESSES
================================================================ */
console.log('\n=== A. the buttons open exactly the addresses given ===');
{
  ok(ABOUT.length > 0, 'the ABOUT modal is found in chat.html');
  const mods = tagById('about-mods-btn');
  const discord = tagById('about-discord-btn');
  ok(!!mods, 'there is a MODS button');
  ok(!!discord, 'there is a DISCORD button');
  eq(mods && mods.text, 'MODS', 'it reads MODS');
  eq(discord && discord.text, 'DISCORD', 'it reads DISCORD');
  ok(!!mods && mods.tag.includes(`onclick="openAboutLink('${MODS_URL}')"`),
     'MODS opens ' + MODS_URL, mods && mods.tag);
  ok(!!discord && discord.tag.includes(`onclick="openAboutLink('${DISCORD_URL}')"`),
     'DISCORD opens ' + DISCORD_URL, discord && discord.tag);
  ok(!/<a\b[^>]*href="https?:/.test(ABOUT),
     'they are buttons, not links (an <a class="btn"> renders underlined)');
}

/* ================================================================
   B. OPENING ONE CANNOT HAND ANYTHING BACK
================================================================ */
console.log('\n=== B. a new tab, with noopener and noreferrer ===');
{
  const m = /function openAboutLink\(url\) \{[\s\S]*?\n\}/.exec(SCHED_SRC);
  ok(!!m, 'js/22-scheduler.js defines openAboutLink(url)');
  const calls = [];
  const ctx = { window: { open: (...a) => { calls.push(a); return null; } } };
  vm.createContext(ctx);
  if (m) vm.runInContext(m[0], ctx);
  let threw = null;
  try { ctx.openAboutLink(DISCORD_URL); } catch (e) { threw = e; }
  ok(threw === null, 'a null return from window.open (what noopener does) is not treated as an error',
     threw && threw.message);
  eq(calls.length, 1, 'one window.open per click');
  const [url, target, features] = calls[0] || [];
  eq(url, DISCORD_URL, 'it opens the address it was given');
  eq(target, '_blank', 'in a new tab');
  ok(/\bnoopener\b/.test(features || ''), 'with noopener', features);
  ok(/\bnoreferrer\b/.test(features || ''), 'with noreferrer', features);
}

/* ================================================================
   C. NOTHING CONTACTS THESE SITES ON ITS OWN
================================================================ */
console.log('\n=== C. no request is made until a button is clicked ===');
{
  const inScripts = JS_FILES.filter(f => {
    const s = fs.readFileSync(ROOT + '/js/' + f, 'utf8');
    return s.includes('discord.gg') || s.includes('goblincorps.com/gobbonet_extras');
  });
  eq(inScripts.join(', '), '', 'neither address appears in any script — only in click handlers');
  const upd = tagById('about-update-btn');
  ok(!!upd, 'there is a CHECK FOR UPDATES button');
  const build = ABOUT.slice(ABOUT.indexOf('id="about-build"'), ABOUT.indexOf('PRIVATE BY DESIGN'));
  ok(!!upd && build.includes(upd.tag), 'it lives under THIS BUILD now, not among the links (1.8.0)');
  ok(!!upd && upd.tag.includes('onclick="checkForUpdates(this)"') && !/\bdisabled\b/.test(upd.tag),
     'and it works: pressing it is what checks', upd && upd.tag);
  ok(!/Update checks are coming in a later version/.test(ABOUT), 'the "coming in a later version" note is gone');
  ok(/CHECK FOR UPDATES when you press it/.test(ABOUT), 'PRIVATE BY DESIGN lists the update check among the calls you ask for');
}

/* ================================================================
   D. THE BOX IS A COPY OF YOUR DATA
================================================================ */
console.log('\n=== D. the new box copies an existing one exactly ===');
{
  // The opening <div style="..."> immediately before a heading.
  const boxBefore = (heading) => {
    const i = ABOUT.indexOf(heading);
    if (i < 0) return null;
    const m = /<div style="(padding:[^"]*)">\s*<div style="([^"]*)">[^<]*$/.exec(ABOUT.slice(0, i));
    return m ? { box: m[1], head: m[2] } : null;
  };
  const data = boxBefore('YOUR DATA</div>');
  const links = boxBefore('LINKS</div>');
  ok(!!data && !!links, 'both boxes are found');
  eq(links && links.box, data && data.box, 'the box style is YOUR DATA’s, character for character');
  eq(links && links.head, data && data.head, 'and so is the heading style');
  ok(ABOUT.indexOf('LINKS</div>') > ABOUT.indexOf('YOUR DATA</div>'), 'it comes after YOUR DATA');
  ok(ABOUT.indexOf('LINKS</div>') < ABOUT.indexOf('class="modal-actions"'), 'and before CLOSE');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
