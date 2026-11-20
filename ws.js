/* ws.js — the project workspace behind the "+" menu.
   Holds the uploaded / AI-built files in memory (and IndexedDB), checks them,
   builds the snapshot the AI sees, and applies the AI's file blocks. */
(function (g) {
  "use strict";
  var enc = new TextEncoder();
  var MAX_FILES = 10000, MAX_PUT = 50 * 1024 * 1024; // 50 MB per AI-created/edited text file

  var SKIP_DIR = /(^|\/)(__MACOSX|node_modules|\.git|\.svn|\.idea|\.vscode)(\/|$)/;
  var SKIP_FILE = /(^|\/)(\.DS_Store|Thumbs\.db)$/;
  var BIN_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|pdf|zip|gz|tgz|7z|rar|woff2?|ttf|otf|eot|mp[34]|m4a|wav|ogg|webm|mov|avi|wasm|bin|exe|dll|so|dylib|jar|class|psd|sqlite|db)$/i;
  var SECRET_FILE = /(^|\/)\.env(\.|$)|(^|\/)(id_rsa|id_ed25519)$|\.(pem|key|p12|pfx)$/i;
  var PLACEHOLDER = /(rest of (the )?(code|file)|(remains?|stays?) (the )?same|(code|content|file) (is |remains )?unchanged|existing code|\.\.\.\s*\(?(rest|remaining|other|existing|previous))/i;
  var SECRET_RE = /(sk-[A-Za-z0-9_-]{20,}|nvapi-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|gsk_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/;

  var ws = { name: "", root: "", fromZip: false, files: new Map(), base: new Map(), orig: new Map(), hidden: new Set(), skipped: 0, prev: null };

  var text = function (b) { return new TextDecoder("utf-8").decode(b); };
  function fmt(n) { return n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB"; }
  function size() { var n = 0; ws.files.forEach(function (b) { n += b.length; }); return n; }
  function isBin(p, b) {
    if (BIN_EXT.test(p)) return true;
    for (var i = 0, n = Math.min(b.length, 8000); i < n; i++) if (b[i] === 0) return true;
    return false;
  }

  // Normalise a path from a ZIP or from the AI. Returns null when it is unsafe or empty.
  function clean(p) {
    var seg = [], parts = String(p == null ? "" : p).trim().replace(/\\/g, "/").split("/");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "" || parts[i] === ".") continue;
      if (parts[i] === "..") return null;
      seg.push(parts[i]);
    }
    if (!seg.length || /^[a-z]:$/i.test(seg[0])) return null;
    p = seg.join("/");
    return p.length <= 200 && !/[\u0000-\u001f]/.test(p) ? p : null;
  }
  function stripRoot(p) {
    p = String(p || "").replace(/\\/g, "/").replace(/^\.?\/+/, "");
    return ws.root && p.indexOf(ws.root + "/") === 0 ? p.slice(ws.root.length + 1) : p;
  }

  // ---------- load / clear ----------
  function load(entries, name) {
    var list = [], skipped = 0, i;
    for (i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.dir) continue;
      var p = clean(e.name);
      if (!p || SKIP_DIR.test(p) || SKIP_FILE.test(p)) { skipped++; continue; }
      list.push([p, e.data]);
    }
    if (!list.length) throw new Error("the ZIP has no usable files");
    var root = "", tops = {}, nTop = 0;
    list.forEach(function (x) { var t = x[0].split("/")[0]; if (!tops[t]) { tops[t] = 1; nTop++; } });
    if (nTop === 1 && list.every(function (x) { return x[0].indexOf("/") > 0; })) {
      root = Object.keys(tops)[0];
      list = list.map(function (x) { return [x[0].slice(root.length + 1), x[1]]; });
    }
    ws.files = new Map(list);
    ws.orig = new Map(list);
    ws.base = new Map();
    ws.files.forEach(function (b, p) { ws.base.set(p, g.Zip.crc32(b)); });
    ws.root = root;
    ws.name = name || root || "project";
    ws.fromZip = true;
    ws.skipped = skipped;
    ws.hidden = new Set();
    ws.prev = null;
    return ws;
  }
  function clear() {
    ws.files = new Map(); ws.base = new Map(); ws.hidden = new Set(); ws.prev = null; ws.orig = new Map();
    ws.name = ""; ws.root = ""; ws.fromZip = false; ws.skipped = 0;
  }

  // What changed compared to the uploaded ZIP.
  function diff() {
    var d = { added: [], modified: [], deleted: [] };
    ws.files.forEach(function (b, p) {
      if (!ws.base.has(p)) d.added.push(p);
      else if (ws.base.get(p) !== g.Zip.crc32(b)) d.modified.push(p);
    });
    ws.base.forEach(function (_, p) { if (!ws.files.has(p)) d.deleted.push(p); });
    return d;
  }
  function nChanged() { var d = diff(); return d.added.length + d.modified.length + d.deleted.length; }

  function entries() {
    var pre = ws.root ? ws.root + "/" : "";
    return Array.from(ws.files.keys()).sort().map(function (p) { return { name: pre + p, data: ws.files.get(p) }; });
  }
  function outName(custom) {
    var c = String(custom || "").trim().replace(/\.zip$/i, "").replace(/[^\w.\- ]+/g, "-").replace(/^-+|-+$/g, "");
    if (c) return c + ".zip";
    var n = (ws.name || "project").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
    return n + (ws.fromZip && nChanged() ? "-fixed" : "") + ".zip";
  }

  // ---------- check ----------
  function jsErr(src) {
    try { new Function(src.replace(/^#!.*/, "")); return ""; }   // compiles only, never runs
    catch (e) { return e instanceof SyntaxError ? e.message : ""; }
  }
  function resolve(dir, ref) {
    var seg = ref.charAt(0) === "/" ? [] : dir.split("/").filter(Boolean), parts = ref.replace(/^\/+/, "").split("/");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "" || parts[i] === ".") continue;
      if (parts[i] === "..") { if (!seg.length) return null; seg.pop(); } else seg.push(parts[i]);
    }
    return seg.join("/");
  }

  function check() {
    var out = [], names = new Set(ws.files.keys()), lower = new Map(), modules = 0, hasHtml = false;
    function add(sev, file, msg) { out.push({ sev: sev, file: file, msg: msg }); }
    names.forEach(function (n) {
      var l = n.toLowerCase();
      if (lower.has(l)) add("warn", n, "same name as " + lower.get(l) + " except for upper/lower case");
      else lower.set(l, n);
    });

    ws.files.forEach(function (b, p) {
      if (SECRET_FILE.test(p)) { add("warn", p, "secrets file — kept in your ZIP, never sent to the AI. Don't publish it."); return; }
      if (!b.length) { add("info", p, "file is empty"); return; }
      if (isBin(p, b)) return;
      var s = text(b), m = p.match(/\.([^./]+)$/), ext = m ? m[1].toLowerCase() : "", err, hit;

      if ((hit = s.match(SECRET_RE))) add("warn", p, "looks like a real API key (" + hit[0].slice(0, 6) + "…). Remove it before publishing.");

      if (ext === "json") {
        if (!/(^|\/)(tsconfig|jsconfig)[^/]*\.json$|\.eslintrc\.json$/.test(p)) {
          try { JSON.parse(s); } catch (e) { add("error", p, "invalid JSON: " + e.message); }
        }
      } else if (ext === "js" || ext === "cjs" || ext === "mjs") {
        if (ext === "mjs" || /^\s*(import\s[^(]|export\s)/m.test(s)) modules++;
        else if ((err = jsErr(s))) add("error", p, "JavaScript syntax error: " + err);
      } else if (ext === "css") {
        var t = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'/g, ""), d = 0, extra = false;
        for (var i = 0; i < t.length; i++) {
          if (t[i] === "{") d++;
          else if (t[i] === "}") { if (--d < 0) { extra = true; d = 0; } }
        }
        if (d > 0) add("error", p, d + " unclosed '{' in CSS");
        if (extra) add("error", p, "extra '}' in CSS");
      } else if (ext === "html" || ext === "htm") {
        hasHtml = true;
        var dir = p.indexOf("/") > 0 ? p.slice(0, p.lastIndexOf("/")) : "", re = /<(?:script|link|img|source|a|iframe|video|audio)\b[^>]*?\s(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi, mm, seen = {};
        while ((mm = re.exec(s))) {
          var ref = (mm[1] != null ? mm[1] : mm[2]).trim().split(/[?#]/)[0];
          if (!ref || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(ref) || !/\.[A-Za-z0-9]{1,6}$/.test(ref) || /[{}<$]/.test(ref) || seen[ref]) continue;
          seen[ref] = 1;
          try { ref = decodeURIComponent(ref); } catch (e) {}
          var r = resolve(dir, ref);
          if (r == null || names.has(r)) continue;
          if (lower.has(r.toLowerCase())) add("warn", p, 'links to "' + ref + '" but the file is named "' + lower.get(r.toLowerCase()) + '" (case matters on GitHub Pages)');
          else add("warn", p, 'links to "' + ref + '" which is not in the project');
        }
        var sr = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi, sm;
        while ((sm = sr.exec(s))) {
          if (/\ssrc\s*=/i.test(sm[1]) || !sm[2].trim()) continue;
          var ty = sm[1].match(/\stype\s*=\s*["']?([^"'\s>]+)/i);
          if (ty && !/^(text|application)\/(x-)?javascript$/i.test(ty[1])) continue;
          if ((err = jsErr(sm[2]))) add("error", p, "JavaScript syntax error in an inline <script>: " + err);
        }
      }
    });

    if (hasHtml && !names.has("index.html")) add("warn", "(project)", "no index.html in the project root — GitHub Pages needs one");
    if (modules) add("info", "(project)", modules + " JavaScript module file" + (modules > 1 ? "s were" : " was") + " not syntax-checked (import/export)");
    var rank = { error: 0, warn: 1, info: 2 };
    return out.sort(function (a, b) { return rank[a.sev] - rank[b.sev]; });
  }

  function report(r) {
    var head = "Project check  " + ws.files.size + " files  " + fmt(size());
    if (!r.length) return head + "\n✓ No problems found (JSON, JavaScript syntax, CSS braces, HTML links, leaked keys).";
    var ic = { error: "✗", warn: "!", info: "-" };
    return head + "\n" + r.map(function (x) { return ic[x.sev] + " " + x.file + "  " + x.msg; }).join("\n");
  }

  // ---------- what the AI sees ----------
  var PROTOCOL = [
    "You work inside a browser-based project workspace. The user can upload a ZIP project and download the whole project as a ZIP at any time.",
    "For a small change to an existing file, use an edit block: a fenced block with info string edit:<relative path>, holding one or more pairs in this exact form:",
    "```edit:src/app.js",
    "<<<<<<< SEARCH",
    "exact existing lines, copied from the file in the context (same indentation)",
    "=======",
    "the replacement lines",
    ">>>>>>> REPLACE",
    "```",
    "Each SEARCH text must occur exactly once in the current file, so include enough surrounding lines to make it unique. The website applies the pairs in order.",
    "For a new file, or a change that rewrites most of a file, output the complete file in a fenced block with info string file:<relative path>. Never send partial code or \"rest unchanged\" inside a file: block. Example:",
    "```file:src/app.js",
    "...complete file content...",
    "```",
    "Use a longer fence (four backticks) if the content contains triple backticks. To delete a file, use a block with info string delete:<path> and an empty body. Use forward slashes; no leading slash and no \"..\". Explain the changes briefly outside the blocks.",
    "If you need a file that is not in the context, reply with a fenced block with info string read that lists one path per line, and nothing else. The website sends those files in its next message.",
    "For questions and short snippets, use normal code blocks without file:, edit: or read:. You cannot run code or reach the network, so never claim you tested something."
  ].join("\n");

  function snapshot(budget, query) {
    ws.hidden = new Set();
    if (!ws.files.size) return "";
    budget = budget || 135000;
    query = String(query || "").toLowerCase();
    var stop = new Set(["the","and","for","with","from","this","that","please","project","code","file","files","fix","make","work","into","what","why","how","all","are","can","you"]);
    var terms = (query.match(/[a-z0-9_./-]{2,}/g) || []).filter(function (t) { return !stop.has(t); }).slice(0, 24);
    var all = Array.from(ws.files.keys()).sort(), cand = [];
    var treeFull = all.map(function (p) { return "- " + p + " (" + fmt(ws.files.get(p).length) + ")"; }).join("\n");
    var tree = treeFull.length > 80000 ? treeFull.slice(0, 80000) + "\n... file tree shortened; total paths: " + all.length : treeFull;
    var important = /(^|\/)(package\.json|pnpm-lock\.yaml|yarn\.lock|package-lock\.json|readme[^/]*|vite\.config\.[^/]+|next\.config\.[^/]+|tsconfig\.json|pyproject\.toml|requirements\.txt|Cargo\.toml|go\.mod|pom\.xml|build\.gradle|dockerfile|\.github\/workflows\/[^/]+)$/i;
    all.forEach(function (p) {
      var b = ws.files.get(p);
      if (SECRET_FILE.test(p) || isBin(p, b)) { ws.hidden.add(p); return; }
      var content = text(b), lower = p.toLowerCase(), score = 0;
      if (important.test(p)) score += 100;
      if (/(^|\/)(agents|claude)\.md$/i.test(p)) score += 500;
      if (/^(src\/)?(index|main|app|server|routes|api)\.[^/]+$/i.test(p)) score += 35;
      if (/\.(js|jsx|ts|tsx|py|go|rs|java|php|rb|vue|svelte)$/i.test(p)) score += 8;
      terms.forEach(function (term) {
        if (lower.indexOf(term) >= 0) score += 24;
        var hits = content.toLowerCase().split(term).length - 1;
        if (hits) score += Math.min(30, hits * 2);
      });
      cand.push({ path: p, content: content, score: score });
    });
    cand.sort(function (a, b) { return b.score - a.score || a.path.localeCompare(b.path); });
    var shown = new Map(), used = 0;
    cand.forEach(function (x) {
      var cost = x.content.length + x.path.length + 50;
      if (used + cost <= budget) { used += cost; shown.set(x.path, x.content); }
      else ws.hidden.add(x.path);
    });
    var body = all.filter(function (p) { return shown.has(p); }).map(function (p) {
      var s = shown.get(p);
      return '<file path="' + p + '">\n' + s + (s.slice(-1) === "\n" || !s ? "" : "\n") + "</file>";
    }).join("\n");
    var hid = Array.from(ws.hidden);
    var hiddenList = hid.slice(0, 250).join(", ") + (hid.length > 250 ? ", ... and " + (hid.length - 250) + " more" : "");
    var instr = all.some(function (p) { return /(^|\/)(agents|claude)\.md$/i.test(p) && shown.has(p); });
    return (instr ? "Project instructions in AGENTS.md / CLAUDE.md are binding for this project. Follow them.\n" : "") + 'Project "' + ws.name + '" (' + ws.files.size + " files; " + fmt(size()) + ").\n" +
      "Full file tree (all paths):\n" + tree + "\n\n" +
      "Task-focused source context (selected by filenames, project manifests and task keywords; " + shown.size + " files shown):\n" + body +
      (hid.length ? "\n\nFiles not included in this request (binary, secret, or outside context budget): " + hiddenList +
      ". Do not claim to have read these files. Ask for a narrower task or inspect relevant files in a follow-up." : "");
  }

  // ---------- AI replies -> file changes ----------
  function fileInfo(info) {
    info = String(info || "").trim();
    var unq = function (s) { return s.replace(/^["'`]+|["'`,;]+$/g, ""); };
    var m = info.match(/^(?:[\w+#.-]+\s+)?(file|delete|edit)\s*[:=]\s*(\S+)/i);
    if (m) { var p = unq(m[2]); return p ? { op: m[1].toLowerCase() === "delete" ? "delete" : m[1].toLowerCase() === "edit" ? "edit" : "put", path: p } : null; }
    m = info.match(/^[\w+#-]+:([^\s:]*\.[A-Za-z0-9]+)$/);          // e.g. ```js:src/app.js
    return m ? { op: "put", path: unq(m[1]) } : null;
  }

  // Returns {edits:[{op,path,content}], cut:[path]}; blocks that never closed are reported in `cut`.
  function parse(reply) {
    var L = String(reply || "").split("\n"), edits = [], cut = [], i = 0;
    while (i < L.length) {
      var o = L[i].match(/^\s{0,3}(`{3,}|~{3,})\s*(.*)$/);
      if (!o) { i++; continue; }
      var fence = o[1], fi = fileInfo(o[2]), body = [], closed = false;
      i++;
      while (i < L.length) {
        var c = L[i].match(/^\s{0,3}(`{3,}|~{3,})\s*$/);
        if (c && c[1].charAt(0) === fence.charAt(0) && c[1].length >= fence.length) { closed = true; i++; break; }
        body.push(L[i++]);
      }
      if (!fi) continue;
      if (!closed) { cut.push(fi.path); break; }
      edits.push({ op: fi.op, path: fi.path, content: body.length ? body.join("\n") + "\n" : "" });
    }
    return { edits: edits, cut: cut };
  }

  function apply(edits) {
    var r = { added: [], modified: [], deleted: [], skipped: [], warn: [] }, before = new Map(ws.files);
    if (!ws.files.size && !ws.name) { ws.name = "project"; ws.root = "project"; ws.fromZip = false; ws.base = new Map(); }
    edits.forEach(function (e) {
      var p = clean(stripRoot(e.path));
      if (!p) { r.skipped.push(e.path + " (invalid path)"); return; }
      if (ws.hidden.has(p) && ws.files.has(p)) { r.skipped.push(p + " (was not shown to the AI — kept as is)"); return; }
      if (e.op === "delete") {
        if (ws.files.delete(p)) r.deleted.push(p); else r.skipped.push(p + " (not in the project)");
        return;
      }
      if (e.op === "edit") { var nx = editFile(p, e.content, r); if (nx === null) return; e = { op: "put", path: e.path, content: nx }; }
      var b = enc.encode(e.content), had = ws.files.get(p);
      if (b.length > MAX_PUT) { r.skipped.push(p + " (file too large)"); return; }
      if (!had && ws.files.size >= MAX_FILES) { r.skipped.push(p + " (too many files)"); return; }
      if (had && had.length === b.length && g.Zip.crc32(had) === g.Zip.crc32(b)) return;
      if (had) {   // catch the classic failure: the AI returns only part of a file
        if (had.length > 400 && b.length < had.length * 0.4) r.warn.push(p + " shrank from " + fmt(had.length) + " to " + fmt(b.length) + " — the AI may have left parts out");
        else if (PLACEHOLDER.test(e.content) && !PLACEHOLDER.test(text(had))) r.warn.push(p + " contains a placeholder such as \"rest unchanged\" — parts may be missing");
      }
      ws.files.set(p, b);
      (had ? r.modified : r.added).push(p);
    });
    if (r.added.length + r.modified.length + r.deleted.length) ws.prev = before;   // lets /undo go back one step
    return r;
  }
  function undo() {
    if (!ws.prev) return false;
    ws.files = ws.prev; ws.prev = null; ws.hidden = new Set();
    if (!ws.files.size) clear();
    return true;
  }

  // ---------- persistence (IndexedDB) so a reload or a discarded tab doesn't lose the project ----------
  function idb() {
    return new Promise(function (res, rej) {
      if (typeof indexedDB === "undefined") return rej(new Error("no IndexedDB"));
      var r = indexedDB.open("codeagent", 1);
      r.onupgradeneeded = function () { r.result.createObjectStore("ws"); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function persist() {
    try {
      var db = await idb();
      await new Promise(function (res, rej) {
        var t = db.transaction("ws", "readwrite"), s = t.objectStore("ws");
        if (ws.files.size) s.put({ name: ws.name, root: ws.root, fromZip: ws.fromZip, skipped: ws.skipped, files: Array.from(ws.files), base: Array.from(ws.base) }, "cur");
        else s.delete("cur");
        t.oncomplete = res; t.onerror = t.onabort = function () { rej(t.error); };
      });
      db.close();
    } catch (e) { /* storage unavailable or full: keep working in memory */ }
  }
  async function restore() {
    try {
      var db = await idb();
      var d = await new Promise(function (res, rej) {
        var q = db.transaction("ws").objectStore("ws").get("cur");
        q.onsuccess = function () { res(q.result); }; q.onerror = function () { rej(q.error); };
      });
      db.close();
      if (!d || !d.files || !d.files.length) return false;
      ws.files = new Map(d.files); ws.base = new Map(d.base || []); ws.orig = new Map();
      ws.name = d.name; ws.root = d.root || ""; ws.fromZip = !!d.fromZip; ws.skipped = d.skipped || 0; ws.hidden = new Set();
      return true;
    } catch (e) { return false; }
  }

  // ---------- edit blocks, read requests, diff (v10) ----------
  var EDIT_RE = /<{7} SEARCH\n([\s\S]*?)\n={7}\n([\s\S]*?)>{7} REPLACE/g;
  // Applies SEARCH/REPLACE pairs to one file. Returns the new text, or null (and says why) if any pair fails.
  function editFile(p, body, r) {
    if (!ws.files.has(p)) { r.skipped.push(p + " (edit: file is not in the project)"); return null; }
    var s = text(ws.files.get(p)), pairs = [], m, i, n;
    EDIT_RE.lastIndex = 0;
    while ((m = EDIT_RE.exec(String(body)))) pairs.push([m[1], m[2].replace(/\n$/, "")]);
    if (!pairs.length) { r.skipped.push(p + " (edit block has no SEARCH/REPLACE pair)"); return null; }
    for (i = 0; i < pairs.length; i++) {
      // Whole lines: match SEARCH with its newline (so an empty REPLACE removes the line). If the file has no
      // newline after that text (last line), fall back to the bare text.
      var S = pairs[i][0], R = pairs[i][1], sx = S + "\n", rx = R === "" ? "" : R + "\n";
      n = S ? s.split(sx).length - 1 : 0;
      if (n === 0) { sx = S; rx = R; n = S ? s.split(sx).length - 1 : 0; }
      if (n !== 1) { r.skipped.push(p + " (edit " + (i + 1) + ": search text " + (n ? "matches " + n + " places" : "not found") + "; this edit block left unchanged)"); return null; }
      s = s.replace(sx, function () { return rx; });
    }
    return s;
  }

  // Files the AI asked for with a ```read block. Only files that exist, are text and are not secrets.
  function readReqs(reply) {
    var out = [], re = /^\s{0,3}(`{3,}|~{3,})\s*read\s*$\n([\s\S]*?)^\s{0,3}\1\s*$/gm, m;
    while ((m = re.exec(String(reply || "")))) {
      m[2].split("\n").forEach(function (l) {
        var p = clean(l.trim());
        if (p && out.length < 12 && ws.files.has(p) && !SECRET_FILE.test(p) && !isBin(p, ws.files.get(p)) && out.indexOf(p) < 0) out.push(p);
      });
    }
    return out;
  }
  function readText(paths) {
    var s = "", left = 60000;
    paths.forEach(function (p) {
      if (left <= 0) return;
      var t = text(ws.files.get(p)), x = t.length <= left ? t : t.slice(0, left) + "\n... (truncated)";
      left -= x.length;
      s += '<file path="' + p + '">\n' + x + (x.slice(-1) === "\n" ? "" : "\n") + "</file>\n";
    });
    return "Requested files (you asked to read them):\n" + s + "Continue the task with these files.";
  }

  function sp(s) { return s === "" ? [] : s.replace(/\n$/, "").split("\n"); }
  // One-hunk line diff between the ZIP's original and the current file. Lines are prefixed + / - / space.
  function diffText(p) {
    var A = null, B = null;
    if (ws.orig.has(p)) A = text(ws.orig.get(p));
    else if (ws.base.has(p)) return { msg: "original not kept after a reload; upload the ZIP again to see this diff" };
    if (ws.files.has(p)) B = text(ws.files.get(p));
    var a = sp(A === null ? "" : A), b = sp(B === null ? "" : B);
    var i = 0, ea = a.length, eb = b.length, ops = [], x = 0, y = 0, n, m, L, add = 0, del = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    while (ea > i && eb > i && a[ea - 1] === b[eb - 1]) { ea--; eb--; }
    n = ea - i; m = eb - i;
    if (n * m <= 4000000) {
      L = [];
      for (x = 0; x <= n; x++) L.push(new Uint32Array(m + 1));
      for (x = n - 1; x >= 0; x--) for (y = m - 1; y >= 0; y--)
        L[x][y] = a[i + x] === b[i + y] ? L[x + 1][y + 1] + 1 : Math.max(L[x + 1][y], L[x][y + 1]);
      x = 0; y = 0;
      while (x < n && y < m) {
        if (a[i + x] === b[i + y]) { ops.push(" " + a[i + x]); x++; y++; }
        else if (L[x + 1][y] >= L[x][y + 1]) ops.push("-" + a[i + x++]);
        else ops.push("+" + b[i + y++]);
      }
    }
    for (; x < n; x++) ops.push("-" + a[i + x]);
    for (; y < m; y++) ops.push("+" + b[i + y]);
    ops.forEach(function (o) { if (o[0] === "+") add++; else if (o[0] === "-") del++; });
    var lines = a.slice(Math.max(0, i - 3), i).map(function (l) { return " " + l; }).concat(ops, a.slice(ea, ea + 3).map(function (l) { return " " + l; }));
    if (lines.length > 400) lines = lines.slice(0, 400).concat(["... " + (lines.length - 400) + " more lines"]);
    return { add: add, del: del, lines: lines };
  }

  g.W = {
    ws: ws, load: load, clear: clear, diff: diff, nChanged: nChanged, entries: entries, outName: outName,
    check: check, report: report, snapshot: snapshot, PROTOCOL: PROTOCOL, readReqs: readReqs, readText: readText, diffText: diffText,
    fileInfo: fileInfo, parse: parse, apply: apply, undo: undo, persist: persist, restore: restore, fmt: fmt, size: size, clean: clean
  };
  if (typeof module !== "undefined" && module.exports) module.exports = g.W;
})(typeof window !== "undefined" ? window : globalThis);
