// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// Development: the plugin site and a stand-in host, on two sites as tuttidaw has them.
//   node web/plugin/dev/serve.mjs [SITE] [PLUGIN_PORT] [HOST_PORT]
//   http://127.0.0.1:8791/        the plugin site (SITE, default build/plugin-site-preview), with the headers its _headers
//                                 file gives (as Cloudflare Pages does: CORS on the manifest, the CSPs, wasm's type)
//   http://localhost:8792/        dev/index.html: a minimal tutti-plugin/0 host that embeds it (localhost: an embedder
//                                 of the preview channel's builds only, not of production's)
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(process.argv[2] || path.join(HERE, "../../../build/plugin-site-preview"));
const pport = +(process.argv[3] || 8791), hport = +(process.argv[4] || 8792);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
                ".json": "application/json; charset=utf-8", ".wasm": "application/wasm", ".svg": "image/svg+xml",
                ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8" };

// _headers: blocks of a path pattern (* any characters) and its indented "Name: value" lines; every matching block applies,
// the values of a header set by more than one joined with ", " (as Cloudflare Pages does)
function headerRules() {
  const f = path.join(site, "_headers"), rules = [];
  if (!fs.existsSync(f)) return rules;
  for (const line of fs.readFileSync(f, "utf8").split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) rules.push({ re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), h: [] });
    else if (rules.length) { const i = line.indexOf(":"); rules.at(-1).h.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]); }
  }
  return rules;
}

function serve(root, port, host, extra) {
  http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    let f = path.join(root, p);
    if (f !== root && !f.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }   // (not /x/../../site-2)
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!fs.existsSync(f)) { res.writeHead(404).end("not found"); return; }
    const h = { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream", "Cache-Control": "no-store" };
    const set = {};
    for (const r of extra ? extra() : []) if (r.re.test(p)) for (const [k, v] of r.h) (set[k] ||= []).push(v);
    for (const [k, v] of Object.entries(set)) h[k] = v.join(", ");
    res.writeHead(200, h).end(fs.readFileSync(f));
  }).listen(port, host, () => console.log(`serve: http://${host === "127.0.0.1" ? "127.0.0.1" : "localhost"}:${port}/  (${root})`));
}
serve(site, pport, "127.0.0.1", headerRules);
serve(HERE, hport, "localhost", null);
