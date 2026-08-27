/* gobbonet-backup.js — encrypt & backup your models to GitHub, from the browser.
 *
 * GobboNet extension (Settings → Extensions → paste this URL). Self-contained,
 * no external dependencies, nothing phones home except the GitHub API you
 * authorize. The awrtifact chunk contract: files split into .partN slices,
 * manifest carries per-part and whole sha256 — anything the awrtifact CLI or
 * the artifact workers can fetch can also read what this mod uploads, and vice
 * versa.
 *
 * THE GATE IS THE PASSPHRASE. Everything uploaded is AES-GCM-encrypted with a
 * key derived from your passphrase (PBKDF2-SHA256, 600k iterations). The repo
 * can be PUBLIC or private — the bytes are ciphertext either way. Share the
 * release URL + the passphrase; that is the whole key ceremony.
 *
 *   Connect:  fine-grained PAT (contents:write on your repo) + owner/repo.
 *             Stored in localStorage; the passphrase is NEVER stored.
 *   Backup:   passphrase -> pick a folder -> encrypt+chunk+upload to a draft
 *             release (private repo = private backup; public repo = shareable).
 *   Restore:  passphrase -> list backups -> download -> verify sha256 ->
 *             decrypt -> stitch -> save.
 *
 * Storage: localStorage key "gobbonet.backup" = { token, repo, lastTag }.
 */

(function () {
  "use strict";

  var PART_SIZE = 1900000000; // the awrtifact contract (under GitHub's 2 GiB cap)
  var ITERATIONS = 600000;
  var LS_KEY = "gobbonet.backup";
  var EVENT = "gobbonet:backup"; // mod event seam, same spirit as gobbonet:image

  function storage() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function saveStorage(s) {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  }

  function api(token, path, opts) {
    opts = opts || {};
    var headers = {
      Accept: opts.accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // Browsers ignore a set User-Agent (forbidden header) and send their own,
      // so this only matters for node callers (the round-trip harness, the
      // gate page's fetch) — the GitHub API rejects requests with no UA at all.
      "User-Agent": "gobbonet-backup-mod",
    };
    // Tokenless reads: public repos serve their releases/assets without auth —
    // the gate page (backup-gate.html) shares backups this way.
    if (token) headers.Authorization = "Bearer " + token;
    if (opts.body !== undefined) headers["Content-Type"] = opts.contentType || "application/json";
    var url = /^https?:\/\//.test(path) ? path : "https://api.github.com" + path;
    return fetch(url, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
    }).then(function (r) {
      if (!r.ok && r.status !== 422) {
        return r.json().then(function (j) {
          var e = new Error((j.message || ("HTTP " + r.status)) +
            " (HTTP " + r.status + ", path " + path + ")");
          e.status = r.status;
          throw e;
        });
      }
      return r;
    });
  }

  function sha256Hex(buf) {
    return crypto.subtle.digest("SHA-256", buf).then(function (d) {
      return Array.from(new Uint8Array(d)).map(function (b) {
        return b.toString(16).padStart(2, "0");
      }).join("");
    });
  }

  function deriveKey(passphrase, saltHex) {
    var enc = new TextEncoder();
    var salt = new Uint8Array(saltHex.match(/.{2}/g).map(function (h) { return parseInt(h, 16); }));
    return crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"])
      .then(function (key) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: salt, iterations: ITERATIONS, hash: "SHA-256" },
          key, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      });
  }

  function toHex(u8) {
    return Array.from(u8).map(function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }

  function encryptPart(key, bytes) {
    var iv = crypto.getRandomValues(new Uint8Array(12));
    return crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, key, bytes)
      .then(function (ct) {
        return { iv: toHex(iv), cipher: new Uint8Array(ct) };
      });
  }

  function decryptPart(key, ivHex, cipher) {
    var iv = new Uint8Array(ivHex.match(/.{2}/g).map(function (h) { return parseInt(h, 16); }));
    return crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, cipher);
  }

  // ----------------------------------------------------------------------
  // GitHub upload/download
  // ----------------------------------------------------------------------

  function ensureRelease(token, owner, repo, tag) {
    return api(token, "/repos/" + owner + "/" + repo + "/releases/tags/" + tag)
      .then(function (r) {
        if (r.ok) return r.json();
        return api(token, "/repos/" + owner + "/" + repo + "/releases", {
          method: "POST",
          body: JSON.stringify({ tag_name: tag, name: "Backup " + tag, draft: true }),
        }).then(function (r2) { return r2.json(); });
      })
      .catch(function (e) {
        // The tag lookup 404s for a release that does not exist YET — that is
        // the ordinary FIRST backup, not an error (measured 2026-08-27 by the
        // round-trip harness: without this, the create-if-missing branch was
        // unreachable and every first backup failed). Re-throw anything else.
        if (/HTTP 404/.test(e.message || "")) {
          return api(token, "/repos/" + owner + "/" + repo + "/releases", {
            method: "POST",
            body: JSON.stringify({ tag_name: tag, name: "Backup " + tag, draft: true }),
          }).then(function (r2) { return r2.json(); });
        }
        throw e;
      });
  }

  function uploadAsset(token, uploadUrl, name, bytes) {
    // api.github.com's .../assets?name= upload route returns 404 (measured
    // 2026-08-27 against real releases with every token class and repo shape
    // tried — private and org, draft and published, empty and seeded). The
    // release payload's upload_url (uploads.github.com) is the host the gh CLI
    // uses and the only one that accepts uploads.
    var url = uploadUrl.replace("{?name,label}", "?name=") + encodeURIComponent(name);
    return api(token, url, {
      method: "POST",
      body: bytes,
      contentType: "application/octet-stream",
      accept: "application/vnd.github+json",
    }).then(function (r) {
      if (r.status === 422) return null; // asset already there — resumable
      return r.json();
    });
  }

  function listReleaseAssets(token, owner, repo, tag) {
    return api(token, "/repos/" + owner + "/" + repo + "/releases/tags/" + tag)
      .then(function (r) {
        if (!r.ok) throw new Error("no release " + tag);
        return r.json();
      }).then(function (rel) {
        return api(token, "/repos/" + owner + "/" + repo + "/releases/" + rel.id + "/assets")
          .then(function (r) { return r.json(); });
      });
  }

  function downloadAsset(token, owner, repo, assetId) {
    return api(token, "/repos/" + owner + "/" + repo + "/releases/assets/" + assetId, {
      accept: "application/octet-stream",
    }).then(function (r) { return r.arrayBuffer(); });
  }

  function listBackups(token, owner, repo) {
    return api(token, "/repos/" + owner + "/" + repo + "/releases?per_page=30")
      .then(function (r) { return r.json(); })
      .then(function (rels) {
        return (rels || []).filter(function (r) { return r.tag_name && r.tag_name.indexOf("backup-") === 0; });
      });
  }

  // ----------------------------------------------------------------------
  // The flow
  // ----------------------------------------------------------------------

  function seedEmptyRepo(token, owner, repo) {
    // GitHub refuses to PUBLISH a release in a repo with zero commits
    // ("Repository is empty.", 422) — exactly the state of a brand-new private
    // repo, which is the ordinary FIRST backup (measured 2026-08-27 by the
    // real-API round-trip: the final publish 422s until the repo has content).
    // One init README commit makes the repo real. The commits probe is the only
    // reliable emptiness signal — `size` stays 0 for tiny repos and pushed_at
    // is set at creation. A 422 on the PUT just means content already exists.
    return api(token, "/repos/" + owner + "/" + repo + "/commits?per_page=1")
      .then(function (r) { return r.json(); })
      .catch(function (e) {
        // An empty repo answers the commits probe with 409 "Git Repository is
        // empty." (measured 2026-08-27 against the real API) — that IS the
        // empty signal; proceed to seed.
        if (e.status === 409) return [];
        throw e;
      })
      .then(function (commits) {
        if (commits.length > 0) return null;
        return api(token, "/repos/" + owner + "/" + repo + "/contents/README.md", {
          method: "PUT",
          body: JSON.stringify({
            message: "init: backup repo",
            content: btoa("Backups for " + owner + "/" + repo +
              "\nCreated by the GobboNet backup mod. Contents are encrypted; the passphrase is the key.\n"),
          }),
        }).then(function (r2) {
          if (!r2.ok && r2.status !== 422) {
            return r2.json().then(function (j) {
              throw new Error("could not seed the empty repo: " + (j.message || ("HTTP " + r2.status)));
            });
          }
        });
      });
  }

  function backupFiles(token, owner, repo, passphrase, files, onProgress) {
    var salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    var tag = "backup-" + new Date().toISOString().replace(/[:.]/g, "").slice(0, 15);
    return seedEmptyRepo(token, owner, repo).then(function () {
    return deriveKey(passphrase, salt).then(function (key) {
      return ensureRelease(token, owner, repo, tag).then(function (rel) {
        var releaseId = rel.id;
        var uploadUrl = rel.upload_url;
        var manifest = {
          version: 1,
          kdf: "pbkdf2-sha256", iterations: ITERATIONS, salt: salt,
          name: tag, files: [],
        };
        var total = 0;
        function uploadOne(file) {
          var entry = { name: file.name, size: file.size, parts: [] };
          // The whole-file plain hash the restore checks against — recorded
          // here, or the restore's final verification compares against
          // undefined and always fails (measured 2026-08-27 by the round-trip
          // harness). One extra read of a local file; acceptable.
          var nParts = Math.max(1, Math.ceil(file.size / PART_SIZE));
          var chain = file.arrayBuffer()
            .then(function (whole) { return sha256Hex(new Uint8Array(whole)); })
            .then(function (h) { entry.plain_sha256 = h; });
          for (var p = 0; p < nParts; p++) {
            (function (idx) {
              chain = chain.then(function () {
                var start = idx * PART_SIZE;
                var end = Math.min(file.size, start + PART_SIZE);
                return file.slice(start, end).arrayBuffer().then(function (raw) {
                  return sha256Hex(new Uint8Array(raw)).then(function (plainSha) {
                    return encryptPart(key, new Uint8Array(raw)).then(function (enc) {
                      return sha256Hex(enc.cipher).then(function (ctSha) {
                        var partName = file.name + ".part" + idx;
                        return uploadAsset(token, uploadUrl, partName, enc.cipher)
                          .then(function () {
                            entry.parts.push({
                              name: partName, size: enc.cipher.length,
                              sha256: ctSha, plain_sha256: plainSha, iv: enc.iv,
                            });
                            total += enc.cipher.length;
                            onProgress && onProgress(file.name, idx + 1, nParts, total);
                          });
                      });
                    });
                  });
                });
              });
            })(p);
          }
          return chain.then(function () {
            manifest.files.push(entry);
          });
        }
        var seq = Promise.resolve();
        files.forEach(function (f) { seq = seq.then(function () { return uploadOne(f); }); });
        return seq.then(function () {
          return sha256Hex(new TextEncoder().encode(JSON.stringify(manifest))).then(function (m) {
            manifest.manifest_sha256 = m;
            var mb = new TextEncoder().encode(JSON.stringify(manifest, null, 2));
            return uploadAsset(token, uploadUrl, tag + ".backup.json", mb);
          });
        }).then(function () {
          // Publish the draft now that every part is up.
          return api(token, "/repos/" + owner + "/" + repo + "/releases/" + releaseId, {
            method: "PATCH",
            body: JSON.stringify({ draft: false, body: "Encrypted backup — " + manifest.files.length + " file(s). Passphrase-protected (AES-GCM)." }),
          });
        }).then(function () { return { tag: tag, manifest: manifest }; });
      });
    });
    });
  }

  function restoreBackup(token, owner, repo, passphrase, tag, onProgress) {
    return listReleaseAssets(token, owner, repo, tag).then(function (assets) {
      var manAsset = assets.filter(function (a) { return a.name.indexOf(".backup.json") > 0; })[0];
      if (!manAsset) throw new Error("no manifest in " + tag);
      return downloadAsset(token, owner, repo, manAsset.id).then(function (buf) {
        var manifest = JSON.parse(new TextDecoder().decode(buf));
        return deriveKey(passphrase, manifest.salt).then(function (key) {
          var done = 0;
          function fetchOne(file) {
            var chain = Promise.resolve();
            var parts = [];
            file.parts.forEach(function (p) {
              chain = chain.then(function () {
                var a = assets.filter(function (x) { return x.name === p.name; })[0];
                if (!a) throw new Error("missing part " + p.name);
                return downloadAsset(token, owner, repo, a.id).then(function (buf) {
                  return sha256Hex(new Uint8Array(buf)).then(function (got) {
                    if (got !== p.sha256) throw new Error("part " + p.name + " failed sha256");
                    return decryptPart(key, p.iv, new Uint8Array(buf));
                  });
                }).then(function (plain) {
                  return sha256Hex(new Uint8Array(plain)).then(function (plainGot) {
                    if (plainGot !== p.plain_sha256) {
                      throw new Error("part " + p.name + " failed plaintext sha256 after decrypt");
                    }
                    parts.push(new Blob([plain]));
                    done++;
                    onProgress && onProgress(file.name, done, file.parts.length * manifest.files.length);
                  });
                });
              });
            });
            return chain.then(function () {
              var blob = new Blob(parts);
              return blob.arrayBuffer().then(function (buf) {
                return sha256Hex(new Uint8Array(buf)).then(function (got) {
                  if (got !== file.plain_sha256) throw new Error("file " + file.name + " failed whole-file sha256");
                  return { name: file.name, blob: blob };
                });
              });
            });
          }
          var seq = Promise.resolve();
          var out = [];
          manifest.files.forEach(function (f) {
            seq = seq.then(function () { return fetchOne(f).then(function (r) { out.push(r); }); });
          });
          return seq.then(function () { return out; });
        });
      });
    });
  }

  function saveBlob(blob, name) {
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
  }

  // ----------------------------------------------------------------------
  // UI
  // ----------------------------------------------------------------------

  var el = function (tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n[k] = attrs[k]; });
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function panel() {
    var s = storage();
    var root = el("div", { style: "position:fixed;right:14px;bottom:14px;z-index:99999;font-family:system-ui,sans-serif" });
    var btn = el("button", { style: "padding:10px 14px;border:1px solid #888;border-radius:8px;background:#111;color:#eee;cursor:pointer;font-size:14px" }, "💾 Backup");
    var modal = el("div", { style: "display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:100000;align-items:center;justify-content:center" });
    var card = el("div", { style: "width:min(560px,92vw);max-height:86vh;overflow:auto;background:#fff;color:#111;border-radius:12px;padding:18px" });
    var log = el("pre", { style: "white-space:pre-wrap;font-size:12px;background:#f4f4f4;padding:8px;border-radius:6px;max-height:200px;overflow:auto" });
    var status = el("div", { style: "font-size:13px;margin:8px 0;color:#555" });

    function setStatus(m) { status.textContent = m; log.textContent = ""; }

    var tok = el("input", { type: "password", placeholder: "GitHub fine-grained PAT", value: s.token || "", style: "width:100%;padding:8px;margin:4px 0;box-sizing:border-box" });
    var repo = el("input", { placeholder: "owner/repo (private or public)", value: s.repo || "", style: "width:100%;padding:8px;margin:4px 0;box-sizing:border-box" });
    var connectBtn = el("button", {}, "Save connection");
    var pass = el("input", { type: "password", placeholder: "Passphrase (the gate — never stored)", style: "width:100%;padding:8px;margin:4px 0;box-sizing:border-box" });
    var fileInput = el("input", { type: "file", multiple: true, webkitdirectory: "", style: "margin:6px 0" });
    var backupBtn = el("button", {}, "🔒 Encrypt & upload");
    var tagInput = el("input", { placeholder: "backup tag (leave empty: list)", style: "width:70%;padding:8px;margin:4px 0;box-sizing:border-box" });
    var restoreBtn = el("button", {}, "⬇ Restore");
    var closeBtn = el("button", { style: "position:absolute;top:10px;right:10px;background:none;border:none;font-size:18px;cursor:pointer" }, "✕");

    connectBtn.onclick = function () {
      var t = tok.value.trim(), r = repo.value.trim();
      if (!t || !r || r.split("/").length !== 2) { setStatus("token + owner/repo required"); return; }
      api(t, "/repos/" + r).then(function (resp) {
        if (!resp.ok) throw new Error("repo not accessible with this token");
        saveStorage({ token: t, repo: r, lastTag: s.lastTag });
        setStatus("connected to " + r);
      }).catch(function (e) { setStatus("connect failed: " + e.message); });
    };

    backupBtn.onclick = function () {
      var t = s.token, r = s.repo, p = pass.value;
      if (!t || !r) { setStatus("connect first"); return; }
      if (p.length < 8) { setStatus("passphrase must be 8+ characters"); return; }
      if (!fileInput.files || !fileInput.files.length) { setStatus("pick files first"); return; }
      backupBtn.disabled = true;
      setStatus("encrypting + uploading…");
      backupFiles(t, r.split("/")[0], r.split("/")[1], p, Array.prototype.slice.call(fileInput.files),
        function (name, i, n, total) { status.textContent = name + " part " + i + "/" + n + " (" + Math.round(total / 1e6) + " MB uploaded)"; })
        .then(function (res) {
          setStatus("done: release " + res.tag + " — share the URL + your passphrase. The passphrase is the gate.");
          saveStorage({ token: t, repo: r, lastTag: res.tag });
          window.dispatchEvent(new CustomEvent(EVENT, { detail: { tag: res.tag } }));
        })
        .catch(function (e) { setStatus("backup failed: " + e.message); })
        .finally(function () { backupBtn.disabled = false; });
    };

    restoreBtn.onclick = function () {
      var t = s.token, r = s.repo, p = pass.value, tag = tagInput.value.trim() || s.lastTag;
      if (!t || !r) { setStatus("connect first"); return; }
      if (!p) { setStatus("passphrase required"); return; }
      restoreBtn.disabled = true;
      setStatus("downloading " + tag + "…");
      restoreBackup(t, r.split("/")[0], r.split("/")[1], p, tag,
        function (name, i, n) { status.textContent = "part " + i + "/" + n + " (" + name + ")"; })
        .then(function (files) {
          files.forEach(function (f) { saveBlob(f.blob, f.name); });
          setStatus("restored " + files.length + " file(s) — verified sha256, decrypted, saved to Downloads.");
        })
        .catch(function (e) { setStatus("restore failed: " + e.message); })
        .finally(function () { restoreBtn.disabled = false; });
    };

    closeBtn.onclick = function () { modal.style.display = "none"; };
    btn.onclick = function () {
      modal.style.display = "flex";
      if (s.lastTag) tagInput.value = s.lastTag;
    };
    modal.onclick = function (e) { if (e.target === modal) modal.style.display = "none"; };

    card.appendChild(closeBtn);
    card.appendChild(el("h3", {}, "GobboNet backup — encrypted, chunked, GitHub"));
    card.appendChild(el("div", {}, "Connect"));
    card.appendChild(tok); card.appendChild(repo); card.appendChild(connectBtn);
    card.appendChild(el("div", { style: "margin-top:12px" }, "Backup"));
    card.appendChild(pass);
    card.appendChild(fileInput);
    card.appendChild(backupBtn);
    card.appendChild(el("div", { style: "margin-top:12px" }, "Restore"));
    card.appendChild(tagInput); card.appendChild(restoreBtn);
    card.appendChild(status); card.appendChild(log);
    modal.appendChild(card);
    root.appendChild(btn); root.appendChild(modal);
    return root;
  }

  if (document.body) {
    document.body.appendChild(panel());
  } else {
    document.addEventListener("DOMContentLoaded", function () { document.body.appendChild(panel()); });
  }

  // Test seam: the encrypt/chunk/upload/restore core, exposed for the
  // round-trip harness (gobbonet-backup.roundtrip.mjs) — the same spirit
  // as the gobbonet:image event contract: a seam, not a phone-home.
  if (typeof window !== "undefined") {
    window.__gobbonetBackup = { backupFiles: backupFiles, restoreBackup: restoreBackup };
  }
})();
