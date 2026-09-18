/**
 * The "Export for Discord" character-card export: a plain ZIP.
 *
 * WHY THE FORMAT EXISTS
 * ---------------------
 * The V3 PNG export keeps the card in tEXt chunks. Chunks are metadata, and
 * metadata does not survive a platform that re-encodes an upload -- so a card
 * can arrive looking perfectly fine with nothing in it, which is worse than
 * not arriving.
 *
 * THIS USED TO BE A POLYGLOT, and the tests kept that shape long enough to be
 * worth explaining. It was a .jpg with a ZIP appended after the end-of-image
 * marker: a real picture that rendered inline in the channel and still carried
 * the card.
 *
 * Rendering inline IS the re-encode path. Discord describes what it does to an
 * uploaded image as running it "through our resizing player", and resizing
 * rebuilds the file from decoded pixels -- at which point anything that is not
 * pixel data is simply not copied across. The property the polyglot optimised
 * for was the exact mechanism that destroyed its payload, and JPEG gets the
 * heaviest processing of any image type. It worked off disk and lost on the
 * one platform it was named after.
 *
 * So the export is a plain archive, and the portrait is an entry inside it
 * rather than a prefix in front of it. Not an image, so nothing re-encodes it.
 *
 * WHAT THIS PINS
 * --------------
 * Section A is the new shape: a real ZIP, the portrait as a file, and NOT an
 * image by any sniff.
 *
 * Section C still covers the prefixed layout, and deliberately. Nothing writes
 * one now, but files shared from an earlier build exist in the wild and are
 * still read, and the offset arithmetic that makes that work is subtle enough
 * to deserve the coverage: concatenating an ordinary ZIP onto an image leaves
 * every recorded offset short by the length of the image, and the reader here
 * uses those offsets as absolute indices.
 *
 * This drives the real _zipArchiveBytes, _findZipEocd, _readZipDirectory,
 * _readZipEntry and _readCardFromCharx out of js/16-card-io.js. No DOM and no
 * install step: everything under test here is byte manipulation, and the parts
 * that do need a canvas are checked by source guard in section F instead.
 */
import { fileURLToPath } from 'node:url';
import fs from 'fs';
import vm from 'vm';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SRC = fs.readFileSync(ROOT + '/js/16-card-io.js', 'utf8');

/* Sliced by landmark rather than line number, so an edit elsewhere in the
   file does not silently change what is under test. */
const slice = (from, to) => {
  const a = SRC.indexOf(from);
  const b = to ? SRC.indexOf(to) : SRC.length;
  if (a < 0 || b < 0 || b <= a) {
    console.error('could not locate ' + JSON.stringify(from) + ' in js/16-card-io.js');
    process.exit(1);
  }
  return SRC.slice(a, b);
};

const SOURCE_UNDER_TEST = [
  slice('async function _inflate', 'function _parsePngChunks'),
  slice('function _findZipEocd', 'function _imageMimeFromMagic'),
  slice('function _imageMimeFromMagic', 'async function _readCardFromZipTail'),
  slice('let _crc32Table = null;', '/** UTF-8 string -> base64'),
  slice('function _dosDateTime', 'function _liveCardSnapshot'),
].join('\n');

const ctx = {
  console: { error() {}, log() {} },
  TextEncoder, TextDecoder, DataView, Uint8Array, Response, Blob, Promise,
  Math, Date, Error, JSON, RegExp, Object, Number, String,
  CompressionStream: globalThis.CompressionStream,
  DecompressionStream: globalThis.DecompressionStream,
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(SOURCE_UNDER_TEST, ctx);
// Thumbnailing needs a canvas. Stubbed rather than skipped, because without it
// _readCardFromCharx swallows the failure in its try/catch and reports no
// avatar -- which would make "the portrait was found" and "there was no
// portrait" look identical to a test.
vm.runInContext(
  'async function _shrinkImageToDataUrl() { return "data:image/jpeg;base64,STUB"; }', ctx);

const TINY_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsL' +
  'EBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' +
  'FBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCABgAEADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcI' +
  'CQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRol' +
  'JicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ip' +
  'qrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAA' +
  'AAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLR' +
  'ChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaX' +
  'mJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEA' +
  'PwD8zKKKK6DIKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA' +
  'KKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/2Q==';

const JPEG = Uint8Array.from(Buffer.from(TINY_JPEG_B64, 'base64'));
const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

let pass = 0, fail = 0;
const ok = (c, l, extra) => {
  if (c) { pass++; console.log('  \u2713 ' + l); }
  else { fail++; console.log('  \u2717 ' + l + (extra ? '\n      ' + extra : '')); }
};
const eq = (a, b, l) => ok(a === b, l,
  a === b ? '' : `got:  ${JSON.stringify(a)}\n      want: ${JSON.stringify(b)}`);

const CARD = {
  spec: 'chara_card_v3', spec_version: '3.0',
  data: {
    name: 'Archivist',
    description: 'Dry, precise.\nKeeps every receipt.\n\n\tEven the tabbed ones.',
    first_mes: 'You again.',
    tags: ['test', 'caf\u00e9', '\u65e5\u672c\u8a9e', 'emoji \u2728'],
  },
};

async function buildPolyglot(files, prefixLen) {
  const zip = await ctx._zipArchiveBytes(files, prefixLen === undefined ? JPEG.length : prefixLen);
  const out = new Uint8Array(JPEG.length + zip.length);
  out.set(JPEG, 0);
  out.set(zip, JPEG.length);
  return out;
}

/** The four entries the export writes now. */
const cardFilesWithPortrait = () => cardFiles().concat([
  { name: 'assets/icon.jpg', bytes: JPEG },
]);

const cardFiles = () => [
  { name: 'card.json', bytes: enc.encode(JSON.stringify(CARD, null, 2)) },
  { name: 'card_v2.json', bytes: enc.encode(JSON.stringify({ ...CARD, spec: 'chara_card_v2' }, null, 2)) },
  { name: 'README.txt', bytes: enc.encode(ctx._discordReadmeText('Archivist')) },
];

/* ================================================================
   A. STILL A JPEG
================================================================ */
console.log('\n=== A. it is a plain archive, and NOT an image ===');
{
  const plain = await ctx._zipArchiveBytes(cardFilesWithPortrait(), 0);

  ok(plain[0] === 0x50 && plain[1] === 0x4B, 'it starts with a local file header, not image magic');
  eq(ctx._imageMimeFromMagic(plain.buffer), '',
     'and sniffs as no kind of image, which is what keeps it off the re-encode path');

  const entries = ctx._readZipDirectory(plain.buffer);
  ok(!!entries['assets/icon.jpg'], 'the portrait is an entry inside the archive');
  const back = await ctx._readZipEntry(plain.buffer, entries['assets/icon.jpg']);
  ok(back[0] === 0xFF && back[1] === 0xD8, 'and comes back out as a JPEG');
  eq(back.length, JPEG.length, 'byte-for-byte the size it went in');

  // The charx reader finds it without being told, because assets/*icon* is
  // where the spec puts a portrait -- which is also why renaming to .charx
  // works in other apps.
  const card = await ctx._readCardFromCharx(plain.buffer);
  eq(JSON.parse(card.json).data.name, 'Archivist', 'the card reads back');
  ok(!!card.imageDataUrl, 'and the avatar is found in the archive, not inferred from a prefix');
}

console.log('\n=== A2. the prefixed layout still READS, for files already shared ===');
{
  const poly = await buildPolyglot(cardFiles());

  ok(poly[0] === 0xFF && poly[1] === 0xD8 && poly[2] === 0xFF,
     'starts with the JPEG start-of-image marker');
  eq(ctx._imageMimeFromMagic(poly.buffer), 'image/jpeg', 'sniffs as a JPEG by magic bytes');

  // Byte-for-byte identical up to the end of the original image: appending an
  // archive must not touch the picture.
  let same = poly.length > JPEG.length;
  for (let i = 0; i < JPEG.length; i++) if (poly[i] !== JPEG[i]) { same = false; break; }
  ok(same, 'the image bytes in front of the archive are untouched');

  // The end-of-image marker is still where a decoder stops.
  ok(poly[JPEG.length - 2] === 0xFF && poly[JPEG.length - 1] === 0xD9,
     'the end-of-image marker sits exactly where the archive begins');

  ok(poly.length > JPEG.length + 100, 'and there is a real archive after it');
}

/* ================================================================
   B. STILL A ZIP
================================================================ */
console.log('\n=== B. the archive half ===');
{
  const poly = await buildPolyglot(cardFiles());
  const eocd = ctx._findZipEocd(poly.buffer);

  ok(eocd > JPEG.length, 'the end-of-central-directory record is found, past the image');
  eq(eocd, poly.length - 22, 'and it is the last 22 bytes, because there is no archive comment');

  const entries = ctx._readZipDirectory(poly.buffer);
  eq(Object.keys(entries).sort().join(','), 'README.txt,card.json,card_v2.json',
     'every entry is listed');

  const json = dec.decode(await ctx._readZipEntry(poly.buffer, entries['card.json']));
  const back = JSON.parse(json);
  eq(back.data.name, 'Archivist', 'card.json parses');
  eq(back.data.description, CARD.data.description,
     'newlines and tabs in the description survive byte-exactly');
  eq(back.data.tags.join('|'), CARD.data.tags.join('|'),
     'non-ASCII tags survive (UTF-8 in, UTF-8 out)');

  const v2 = JSON.parse(dec.decode(await ctx._readZipEntry(poly.buffer, entries['card_v2.json'])));
  eq(v2.spec, 'chara_card_v2', 'the V2 copy is there for apps that only speak V2');

  const readme = dec.decode(await ctx._readZipEntry(poly.buffer, entries['README.txt']));
  ok(/ordinary ZIP/i.test(readme), 'README.txt says plainly what the file is');
  ok(/\.charx/.test(readme), 'and mentions the .charx route for other apps');
  // The one instruction that decides whether the file survives the trip.
  ok(/as a FILE, not by pasting it as an image/i.test(readme),
     'and tells the sender the thing that actually matters', readme.slice(0, 80));
}

/* ================================================================
   C. WHY THE OFFSETS ARE BIASED

   The whole reason this file is not just `cat image zip > out`.
================================================================ */
console.log('\n=== C. offsets are absolute from byte zero ===');
{
  const poly = await buildPolyglot(cardFiles());
  const dv = new DataView(poly.buffer);
  const eocd = ctx._findZipEocd(poly.buffer);

  // Every recorded local-header offset must point at a real local header
  // within the WHOLE file, not within the archive considered alone.
  const cdStart = dv.getUint32(eocd + 16, true);
  ok(cdStart > JPEG.length, 'the central directory offset accounts for the image in front of it');

  const entries = ctx._readZipDirectory(poly.buffer);
  let allPoint = true;
  for (const name of Object.keys(entries)) {
    const off = entries[name].localOff;
    if (off < JPEG.length || dv.getUint32(off, true) !== 0x04034b50) allPoint = false;
  }
  ok(allPoint, 'every local-header offset lands on a local-header signature');

  // And the naive build -- offsets written as if the archive stood alone --
  // must NOT read, or there would be nothing to justify the bias.
  const naive = await buildPolyglot(cardFiles(), 0);
  let naiveFailed = false;
  try {
    const e = ctx._readZipDirectory(naive.buffer);
    await ctx._readZipEntry(naive.buffer, e['card.json']);
  } catch (err) { naiveFailed = true; }
  ok(naiveFailed, 'an unbiased archive concatenated onto an image does NOT read');

  // A standalone archive (no prefix at all) still has to work.
  const bare = await ctx._zipArchiveBytes(cardFiles(), 0);
  const bareEntries = ctx._readZipDirectory(bare.buffer);
  const bareJson = JSON.parse(dec.decode(await ctx._readZipEntry(bare.buffer, bareEntries['card.json'])));
  eq(bareJson.data.name, 'Archivist', 'prefixLen 0 still produces an ordinary standalone ZIP');
}

/* ================================================================
   D. ENTRY ENCODING

   Both storage methods have to round-trip, because which one is used depends
   on whether the browser has CompressionStream and on whether deflate
   actually helped.
================================================================ */
console.log('\n=== D. stored and deflated entries ===');
{
  // CRC-32 is shared with the PNG chunk writer. The check value for the
  // string "123456789" is the standard one for CRC-32/ISO-HDLC.
  eq(ctx._crc32(enc.encode('123456789')), 0xCBF43926, 'CRC-32 matches the standard check value');

  // Highly repetitive: deflate should win, so this exercises method 8.
  const squishy = enc.encode('A'.repeat(5000));
  // Genuinely incompressible, so the writer must fall back to stored. An
  // xorshift stream rather than something arithmetic like (i * K) >>> 24 --
  // that has a short period and deflate eats it, which would make this
  // assertion quietly test nothing.
  const noisy = new Uint8Array(2048);
  {
    let seed = 0x9e3779b9;
    for (let i = 0; i < noisy.length; i++) {
      seed ^= seed << 13; seed >>>= 0;
      seed ^= seed >>> 17;
      seed ^= seed << 5;  seed >>>= 0;
      noisy[i] = seed & 255;
    }
  }

  const poly = await buildPolyglot([
    { name: 'squishy.txt', bytes: squishy },
    { name: 'noisy.bin', bytes: noisy },
  ]);
  const entries = ctx._readZipDirectory(poly.buffer);

  eq(entries['noisy.bin'].method, 0, 'incompressible data is stored, not inflated by deflating it');
  const backNoisy = await ctx._readZipEntry(poly.buffer, entries['noisy.bin']);
  eq(backNoisy.length, noisy.length, 'stored entry round-trips at the right length');
  let noisySame = true;
  for (let i = 0; i < noisy.length; i++) if (backNoisy[i] !== noisy[i]) { noisySame = false; break; }
  ok(noisySame, 'and byte-for-byte');

  const backSquishy = await ctx._readZipEntry(poly.buffer, entries['squishy.txt']);
  eq(dec.decode(backSquishy), 'A'.repeat(5000), 'the other entry round-trips too');

  if (typeof ctx.CompressionStream === 'function') {
    eq(entries['squishy.txt'].method, 8, 'compressible data is deflated where the runtime can');
    ok(entries['squishy.txt'].compSize < 5000, 'and the stored size is smaller than the input');
  } else {
    eq(entries['squishy.txt'].method, 0, 'no CompressionStream: everything is stored, and still valid');
  }

  // An empty file is a legal ZIP entry and must not throw.
  const withEmpty = await buildPolyglot([{ name: 'empty.txt', bytes: new Uint8Array(0) }]);
  const ee = ctx._readZipDirectory(withEmpty.buffer);
  eq((await ctx._readZipEntry(withEmpty.buffer, ee['empty.txt'])).length, 0,
     'an empty entry round-trips as empty');
}

/* ================================================================
   E. THE IMPORT PATH
================================================================ */
console.log('\n=== E. reading one back as a card ===');
{
  const poly = await buildPolyglot(cardFiles());
  const res = await ctx._readCardFromCharx(poly.buffer);
  const back = JSON.parse(res.json);
  eq(back.data.name, 'Archivist', 'the charx reader finds card.json in the tail archive');
  eq(res.imageDataUrl, '',
     'and reports no embedded asset, so the importer falls back to the image itself');

  // A tail archive with no card.json has to fail loudly rather than import
  // an empty character.
  const wrong = await buildPolyglot([{ name: 'notes.txt', bytes: enc.encode('hello') }]);
  let threw = '';
  try { await ctx._readCardFromCharx(wrong.buffer); } catch (e) { threw = e.message; }
  ok(/card\.json/.test(threw), 'an archive without card.json is rejected by name', threw);

  // A plain image with nothing appended must not look like an archive.
  eq(ctx._findZipEocd(JPEG.buffer.slice(0)), -1, 'an ordinary JPEG has no end-of-central-directory');

  // ...which is also what a "for sharing" export looks like after a platform
  // has re-encoded it: the picture survives, the archive does not. That is the
  // documented limit of the format, and the message the importer gives for it
  // is the only thing standing between the user and a wasted afternoon.
  const stripped = await buildPolyglot(cardFiles());
  const eoi = (() => { for (let i = stripped.length - 2; i > 1; i--) {
    if (stripped[i] === 0xFF && stripped[i + 1] === 0xD9) return i + 2; } return -1; })();
  ok(eoi > 0, 'the end-of-image marker can be located');
  const imageOnly = stripped.slice(0, eoi);
  eq(ctx._findZipEocd(imageOnly.buffer.slice(0, eoi)), -1,
     're-encoding leaves an image with no archive on it');
  eq(ctx._imageMimeFromMagic(imageOnly.buffer.slice(0, eoi)), 'image/jpeg',
     'and it is still recognisably an image, which is how the importer knows');

  // The message must name the cause and point at the fix, which is on the
  // SENDING end. "Embedded card data is not valid JSON" -- the old wording --
  // is a message about JSON, for a picture.
  const dispatcher = SRC.slice(SRC.indexOf('async function importCharacterCard('),
                               SRC.indexOf('CHARACTER CARD EXPORT'));
  ok(/_imageMimeFromMagic\(buf\)/.test(dispatcher),
     'an image with no card is recognised as an image');
  ok(/no character card inside it/.test(dispatcher), 'and says so plainly');
  ok(/re-encoded/.test(dispatcher), 'names what a chat app did to it');
  ok(/download/.test(dispatcher), 'and tells the sender-side fix');
  const jsonBranchAt = dispatcher.indexOf("new TextDecoder('utf-8').decode(new Uint8Array(buf))");
  const imageBranchAt = dispatcher.indexOf('_imageMimeFromMagic(buf)');
  ok(imageBranchAt > 0 && imageBranchAt < jsonBranchAt,
     'and is checked BEFORE the file is decoded as text, or it gets the JSON message instead');

  // Magic-byte sniffing, which is what picks the avatar MIME on import.
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0, 0, 0, 0, 0]);
  eq(ctx._imageMimeFromMagic(png.buffer), 'image/png', 'PNG magic is recognised');
  const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0, 0, 0]);
  eq(ctx._imageMimeFromMagic(webp.buffer), 'image/webp', 'WEBP magic is recognised');
  eq(ctx._imageMimeFromMagic(enc.encode('not an image at all').buffer), '',
     'and anything else reports nothing rather than guessing');
}

/* ================================================================
   F. WIRING

   The export entry point needs a canvas, so it is checked at the source
   level rather than executed.
================================================================ */
console.log('\n=== F. wiring ===');
{
  const html = fs.readFileSync(ROOT + '/chat.html', 'utf8');

  ok(/function exportCardForDiscord\(/.test(SRC), 'exportCardForDiscord exists');
  ok(/onclick="exportCardForDiscord\(\)"/.test(html), 'and the editor has a button for it');
  ok(/accept="[^"]*\.jpg[^"]*"[^>]*importCharacterCard/.test(html),
     'the import picker accepts .jpg, or the export could not be chosen');

  const exportFn = SRC.slice(SRC.indexOf('async function exportCardForDiscord('));
  ok(/_cardImageJpegBytes\(snap, 0\.9\)/.test(exportFn), 'the portrait is encoded as JPEG');
  ok(/name: 'assets\/icon\.jpg', bytes: jpg/.test(exportFn),
     'and goes INSIDE the archive as an entry, not in front of it as a prefix');
  ok(/_zipArchiveBytes\(\[[\s\S]*?\], 0\)/.test(exportFn),
     'the archive is written with no prefix, so it is an ordinary zip');
  ok(/'application\/zip'/.test(exportFn) && /\+ '\.zip'/.test(exportFn),
     'and is named and typed as a zip, so nothing treats it as an image');
  // The whole point. A .jpg goes down the re-encode path that destroys it.
  ok(!/'image\/jpeg'\), _cardFileStem/.test(exportFn) && !/\+ '\.jpg'/.test(exportFn),
     'nothing is downloaded as a .jpg any more');

  // The import picker has to accept what the export produces, or the file
  // cannot even be selected. This was missed once already, for .jpg.
  ok(/accept="[^"]*\.zip[^"]*"[^>]*importCharacterCard/.test(html),
     'the import picker accepts .zip');

  // The V3 PNG export must keep working exactly as it did -- this is an
  // ADDITIONAL option, not a replacement.
  ok(/function exportCardAsV3\(/.test(SRC), 'the V3 PNG export is still there');
  ok(/onclick="exportCardAsV3\(\)"/.test(html), 'and still has its own button');
  ok(/_pngTextChunk\('ccv3'/.test(SRC) && /_pngTextChunk\('chara'/.test(SRC),
     'still writing both the ccv3 and chara chunks');

  // Both exports read the editor through one snapshot, so they can never
  // disagree about what is being exported.
  ok(/_liveCardSnapshot\(\)/.test(SRC.slice(SRC.indexOf('async function exportCardAsV3('))),
     'the V3 export uses the shared live snapshot');
  ok(/_liveCardSnapshot\(\)/.test(exportFn), 'and so does the sharing export');

  // The import dispatcher has to check for a tail archive BEFORE it falls
  // back to decoding the file as JSON text, or a .jpg lands in the text
  // branch and fails with a confusing parse error.
  const importFn = SRC.slice(SRC.indexOf('async function importCharacterCard('),
                             SRC.indexOf('CHARACTER CARD EXPORT'));
  const zipAt = importFn.indexOf('_findZipEocd');
  const textAt = importFn.indexOf("new TextDecoder('utf-8').decode(new Uint8Array(buf))");
  ok(zipAt > 0 && textAt > zipAt, 'import tries the tail archive before falling back to plain text');
  ok(/_readCardFromZipTail\(/.test(importFn), 'and reads it through the tail-archive helper');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
