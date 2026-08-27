// gobbonet-backup.roundtrip.mjs — prove the mod's core logic in node.
//
// Runs the REAL backupFiles/restoreBackup from gobbonet-backup.js against a
// stubbed GitHub API (in-memory releases/assets) and node's WebCrypto.
// A test that reimplements the thing it tests proves nothing — this one
// loads the shipped file and drives its own code.
//
//   node gobbonet-backup.roundtrip.mjs
//   exit 0 = encrypt -> chunk -> upload -> download -> verify -> decrypt
//            -> stitch round-trips byte-exact; exit 1 = something broke.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const modSrc = readFileSync(path.join(dir, "gobbonet-backup.js"), "utf-8");

// --- stubs (skipped in REAL_API mode — see the bottom) ------------------

const REAL_API = !!process.env.REAL_API;
const releases = []; // {tag_name, draft, assets: [{name, bytes}]}

if (!REAL_API) globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const pathname = u.pathname; // /repos/o/r/...
  const json = (body, status = 200) => ({
    ok: status < 400, status,
    json: async () => body,
    arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(body)).buffer,
  });
  // Commit probe (seedEmptyRepo) — brand-new-repo shape: the real API answers
  // an empty repo's commit list with 409 "Git Repository is empty." (measured
  // 2026-08-27 against the live API), and the mod reads that as the seed signal.
  const commitsM = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/commits$/);
  if (commitsM && opts.method === "GET") return json({ message: "Git Repository is empty." }, 409);
  // Init README commit (the seed) — content is base64 in body.
  const readmeM = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/contents\/README.md$/);
  if (readmeM && opts.method === "PUT") return json({ content: { name: "README.md" } }, 201);
  const m = pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/releases(\/tags\/([^/]+))?$/);
  const uploadUrlFor = (id) => `https://uploads.github.com/repos/me/my-repo/releases/${id}/assets{?name,label}`;
  if (m && opts.method === "GET" && m[4]) {
    const rel = releases.find((r) => r.tag_name === m[4]);
    return rel ? json({ id: releases.indexOf(rel), tag_name: rel.tag_name, draft: rel.draft, upload_url: uploadUrlFor(releases.indexOf(rel)) }) : json({ message: "no" }, 404);
  }
  if (m && !m[3] && opts.method === "GET") return json(releases.map((r, i) => ({ ...r, upload_url: uploadUrlFor(i) })));
  if (m && !m[3] && opts.method === "POST") {
    const rel = { ...JSON.parse(opts.body), id: releases.length, assets: [], upload_url: uploadUrlFor(releases.length) };
    releases.push(rel);
    return json({ id: rel.id, tag_name: rel.tag_name, draft: rel.draft, upload_url: rel.upload_url }, 201);
  }
  const relM = pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)$/);
  if (relM && opts.method === "PATCH") {
    const rel = releases[Number(relM[1])];
    Object.assign(rel, JSON.parse(opts.body));
    return json(rel);
  }
  const assetM = pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/);
  if (assetM && opts.method === "POST") {
    const rel = releases[Number(assetM[1])];
    const name = u.searchParams.get("name") || "";
    if (REAL_API) throw new Error("stub reached in REAL_API mode");
    const body = opts.body instanceof Uint8Array ? opts.body : new Uint8Array(await opts.body.arrayBuffer());
    const bytes = body;
    const existing = rel.assets.find((a) => a.name === name);
    if (existing) return json({ message: "exists" }, 422);
    const asset = { id: rel.assets.length, name, bytes };
    rel.assets.push(asset);
    return json({ id: asset.id, name }, 201);
  }
  const listM = pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/(\d+)\/assets$/);
  if (listM) return json(releases[Number(listM[1])].assets.map((a) => ({ id: a.id, name: a.name })));
  const dlM = pathname.match(/^\/repos\/[^/]+\/[^/]+\/releases\/assets\/(\d+)$/);
  if (dlM) {
    const asset = releases.flatMap((r) => r.assets).find((a) => a.id === Number(dlM[1]));
    return { ok: true, status: 200, arrayBuffer: async () => asset.bytes.buffer };
  }
  throw new Error("unhandled stub path " + pathname);
};


const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
};
globalThis.window = globalThis;
globalThis.document = {
  body: { appendChild: () => {} },
  addEventListener: () => {},
  createElement: () => ({
    style: {},
    appendChild: () => {},
    addEventListener: () => {},
    set textContent(_v) {},
    set onclick(_v) {},
    set disabled(_v) {},
  }),
};
globalThis.URL.createObjectURL = () => "blob:stub";
globalThis.URL.revokeObjectURL = () => {};

// --- load the shipped file ---------------------------------------------

new Function(modSrc)();

const { backupFiles, restoreBackup } = globalThis.__gobbonetBackup;
if (!backupFiles || !restoreBackup) {
  console.error("FAIL: test seam not exposed");
  process.exit(1);
}

// --- the round-trip ------------------------------------------------------

const original = "Hello GobboNet — this model is 100% real and needs a backup. ".repeat(50);
const file = {
  name: "my-model.gguf",
  size: original.length,
  slice: (s, e) => ({ arrayBuffer: async () => new TextEncoder().encode(original.slice(s, e)).buffer }),
  arrayBuffer: async () => new TextEncoder().encode(original).buffer,
};

const TOK = REAL_API ? process.env.REAL_TOKEN : "tok";
const REPO = REAL_API ? process.env.REAL_REPO : "me/my-repo";
if (REAL_API && (!TOK || !REPO)) {
  console.error("FAIL: REAL_API needs REAL_TOKEN and REAL_REPO envs");
  process.exit(1);
}
const [R_OWNER, R_NAME] = REPO.split("/");
if (REAL_API && (!R_OWNER || !R_NAME)) {
  console.error("FAIL: REAL_REPO must be owner/name");
  process.exit(1);
}

backupFiles(TOK, R_OWNER, R_NAME, "correct horse battery staple", [file], () => {})
  .then((res) => {
    console.log("DEBUG assets:", JSON.stringify(releases.flatMap((r) => r.assets).map((a) => a.name)));
    console.log("backup ok:", res.tag, "| files:", res.manifest.files.length,
      "| parts:", res.manifest.files[0].parts.length);
    const tag = res.tag;
    return restoreBackup(TOK, R_OWNER, R_NAME, "correct horse battery staple", tag, () => {})
      .then((out) => {
        if (out.length !== 1) throw new Error("expected 1 file back, got " + out.length);
        return out[0].blob.arrayBuffer().then((buf) => {
          const got = new TextDecoder().decode(buf);
          if (got !== original) throw new Error("round-trip bytes differ");
          console.log("restore ok: byte-exact, sha256-verified, decrypted, stitched");
          console.log("ROUND-TRIP PASS");
          process.exit(0);
        });
      });
  })
  .catch((e) => {
    console.error("FAIL:", e.message);
    process.exit(1);
  });
