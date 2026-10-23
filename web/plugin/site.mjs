// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin's static site (web/plugin/build.sh calls it), for Cloudflare Pages or any static host, after Felucca's
// (weavejam/Felucca web/plugin/site.mjs):
//   PLUGIN_CHANNEL=production|preview node web/plugin/site.mjs WASM OUT SLOOP_VERSION
//   OUT/tutti-plugin.json   the manifest (protocol-v0 1), CORS * (_headers)
//   OUT/_headers            Cloudflare Pages: the manifest's CORS and no-cache, frame-ancestors (the channel's embedders),
//                           the plugin page's CSP, wasm's type
//   OUT/plugin/             the entry: SLOOP's web editor (web/editor.html) + tutti-host.js, tutti.js and its modules,
//                           the wasm, the editor's icon font
//   OUT/credits.html, OUT/licenses/   who made what, the licences, the source
//   OUT/index.html          a landing page
// The build id is a hash of everything served but the manifest and plugin/build-info.js (which carry it), and the channel.
// PLUGIN_CHANNEL (required): which pages may embed it (protocol.js CHANNELS), into both plugin/build-info.js (EMBEDDERS,
// the handshake's check) and _headers (frame-ancestors): production exactly https://tuttidaw.com and
// https://www.tuttidaw.com; preview those and http://localhost:<any port>.
// The source link is the commit built (git HEAD): no commit, or a tree with changes not in it, fails the build
// (PLUGIN_ALLOW_DIRTY=1 lets a preview build through, marked as such; never a production one).
// Env: PLUGIN_SOURCE (the source repository, default https://github.com/weavejam/sloop-fm1).
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import { OUTPUTS, SAMPLE_RATES } from "./renderer.js";
import { STATE_VERSION, STATE_READS } from "./state.js";
import { PROTOCOL, CHANNELS } from "./protocol.js";

export const PLUGIN_VERSION = "0.1.0";                 // semver of the plugin (+ SLOOP's version as build metadata)
const UPSTREAM = "https://github.com/isod89/sloop-fm1";
const NOTICE = "Not affiliated with or endorsed by M-VAVE or Hügelton Instruments.";
const [wasmPath, out, fwVersion = "dev"] = process.argv.slice(2);
if (!wasmPath || !out) { console.error("usage: node web/plugin/site.mjs WASM OUT SLOOP_VERSION"); process.exit(2); }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const src = (...p) => path.join(ROOT, ...p);
const fail = (m) => { console.error(`site: ${m}`); process.exit(1); };
const channel = process.env.PLUGIN_CHANNEL;
if (!Object.hasOwn(CHANNELS, channel)) fail(`PLUGIN_CHANNEL=${Object.keys(CHANNELS).join("|")} (not ${channel})`);
const EMBEDDERS = CHANNELS[channel];
const SOURCE = process.env.PLUGIN_SOURCE || "https://github.com/weavejam/sloop-fm1";
const git = (args) => execSync(`git ${args}`, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
let commit = "", changes = "";
try { commit = git("rev-parse --verify HEAD"); changes = git("status --porcelain"); } catch (e) { fail(`no git commit to link the source to (${String(e.message).split("\n")[0]})`); }
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`no git commit to link the source to (${commit})`);
const dirty = changes !== "";
if (dirty && !(channel === "preview" && process.env.PLUGIN_ALLOW_DIRTY === "1"))
  fail(`the tree has changes not in ${commit.slice(0, 12)}: the source link would not be this build's source\n${changes}`);
const sourceAt = `${SOURCE}/tree/${commit}`;
const fw = fwVersion.replace(/^SLOOP\s*/i, "").replace(/^v/, "").replace(/[^0-9A-Za-z.-]/g, "-");
const version = `${PLUGIN_VERSION}+sloop.${fw}${dirty ? ".dirty" : ""}`;

fs.rmSync(out, { recursive: true, force: true });
const put = (rel, data) => {
  const f = path.join(out, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
};
const copy = (from, rel) => put(rel, fs.readFileSync(from));
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ---- the plugin: the editor's page, its SLOOP, the protocol
copy(wasmPath, "plugin/sloop.wasm");
for (const f of ["tutti-host.js", "tutti.js", "protocol.js", "fm1-panel.js", "engine.js", "renderer.js", "resample.js", "state.js",
                 "render-worker.js", "worklet-tutti.js"])
  copy(src("web/plugin", f), `plugin/${f}`);
copy(src("web/fukiai.ttf"), "plugin/fukiai.ttf");
copy(src("web/FUKIAI-LICENSE.txt"), "plugin/FUKIAI-LICENSE.txt");
let page = fs.readFileSync(src("web/editor.html"), "utf8").replace(/\r\n/g, "\n");
const swap = (a, b) => {
  const n = typeof a === "string" ? page.split(a).length - 1 : (page.match(new RegExp(a.source, a.flags.includes("g") ? a.flags : a.flags + "g")) || []).length;
  if (n !== 1) throw new Error(`site: web/editor.html: ${a} ${n} times (once expected)`);
  page = page.replace(a, b);
};
swap("<title>SLOOP Editor</title>", "<title>SLOOP · tuttidaw plugin</title>");
swap(/<!--PWA-->[\s\S]*?<!--\/PWA-->/, '<link rel="icon" href="../icon.svg">');         // (no app here: no manifest,
swap(/\/\*PWA\*\/[\s\S]*?\/\*\/PWA\*\//, "");                                           // no service worker, no install)
swap(/<button id="install"[^>]*><\/button>\s*/, "");
swap(/<!--DL-->[\s\S]*?<!--\/DL-->/, "");                                                // (the offline editor: not this one)
swap('<a class="dim" href="../installer/" data-t="installer"></a>', "");                 // (the FM-1 installer: not here)
swap("\n<script>\n", '\n<script src="tutti-host.js"></script>\n<script type="module" src="tutti.js"></script>\n<script>\n');
put("plugin/index.html", page);

// ---- credits, licences, source
copy(src("LICENSE"), "licenses/LICENSE.txt");
copy(src("LICENSING.md"), "licenses/LICENSING.md");
for (const f of fs.readdirSync(src("LICENSES"))) copy(src("LICENSES", f), `licenses/LICENSES/${f}`);
copy(src("assets/fonts/Terminus-LICENSE.txt"), "licenses/Terminus-LICENSE.txt");
copy(src("web/FUKIAI-LICENSE.txt"), "licenses/FUKIAI-LICENSE.txt");
copy(src("assets/samples-cc0/ATTRIBUTION.txt"), "licenses/samples-ATTRIBUTION.txt");
copy(src("assets/samples-cc0/CREDITS.txt"), "licenses/samples-CREDITS.txt");
const STYLE = `<style>
body { font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; margin: 0; color: #111; background: #f4f4f5; }
main { max-width: 780px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { font-size: 26px; margin: 0 0 4px; } h2 { font-size: 18px; margin: 28px 0 8px; }
a { color: #0b57d0; } code { font-size: 13px; } .notice { padding: 10px 14px; background: #fff; border-left: 4px solid #111; }
td, th { text-align: left; vertical-align: top; padding: 4px 8px; border-bottom: 1px solid #ddd; } table { border-collapse: collapse; }
</style>`;
const src1 = (f) => `<a href="${esc(sourceAt)}/${f}">${esc(f)}</a>`;
put("credits.html", `<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-only -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SLOOP plugin · credits, licences, source</title>${STYLE}</head><body><main>
<h1>SLOOP plugin for tuttidaw</h1>
<p>Version ${esc(version)} · <a href="plugin/">open the plugin</a></p>
<p class="notice"><strong>${esc(NOTICE)}</strong> This is weavejam's plugin build of SLOOP by isod89: SLOOP, a groovebox
firmware for the M-VAVE FM-1, running in your browser as a <a href="https://tuttidaw.com">tuttidaw</a> plugin. It contains
no M-VAVE material. "M-VAVE" and "FM-1" are trademarks of their respective owners; "Felucca" and "Hügelton Instruments" are
names of Hügelton Instruments.</p>
<h2>Who made it</h2>
<ul>
<li><strong>SLOOP</strong>, the firmware this plugin is built from (all of the sound, the sequencer, the song mode and the
  web editor that is the plugin's page), by <strong>isod89</strong> and its contributors:
  <a href="${UPSTREAM}">${UPSTREAM.replace(/^https:\/\//, "")}</a>. The credits of SLOOP (its README, "Credits and
  thanks") name them: andrerezemini (sloop-lab: the second core), Charles Vestal (X0X), keremimo (Melodee),
  juanjiant-bit (JIANT FM), renebohne, ChanceTheMaker, @ordenador / Mario Faúndez Vidal (the editor's local audio
  preview in WebAssembly, which this plugin's renderer grew from), and everyone who reported and asked.</li>
<li><strong>Felucca</strong>, which SLOOP is based on (the engines, the sequencer, the editor and the installer), by
  <a href="https://github.com/kurogedelic">Leo Kuroshita</a>, <a href="https://hugelton.com">Hügelton Instruments</a>:
  <a href="https://github.com/hugelton/Felucca">github.com/hugelton/Felucca</a>.</li>
<li>The tuttidaw plugin (the device and the headless renderer in WebAssembly, the fractional tempo, the stems, the
  editor on a SLOOP in the page, the protocol): <strong>weavejam</strong>, in the fork
  <a href="${esc(SOURCE)}">${esc(SOURCE.replace(/^https:\/\//, ""))}</a>, after weavejam's FM-1 plugin built from
  Felucca (<a href="https://github.com/weavejam/Felucca">github.com/weavejam/Felucca</a>).</li>
</ul>
<h2>Licence</h2>
<p>This plugin is free software under the <a href="licenses/LICENSE.txt">GNU General Public License, version 3 only</a>
(GPL-3.0-only); see SLOOP's <a href="licenses/LICENSING.md">LICENSING.md</a>. It includes parts under other licences,
each kept:</p>
<table>
<tr><th>What</th><th>Licence</th><th>Notice</th></tr>
<tr><td>Instrument and drum samples of the SAMPLE engine and the drum kit (Versilian Studios VSCO-2 CE and VCSL; Sonic Pi:
  the scratches)</td><td>CC0 1.0</td><td><a href="licenses/samples-ATTRIBUTION.txt">ATTRIBUTION.txt</a>,
  <a href="licenses/samples-CREDITS.txt">CREDITS.txt</a></td></tr>
<tr><td>msfa (Google Inc., Pascal Gauthier; from Dexed): the FM6 engine's synthesis, ${src1("firmware/src/fm6_core.c")}</td>
  <td>Apache-2.0</td><td>${fs.readdirSync(src("LICENSES")).map((f) => `<a href="licenses/LICENSES/${f}">${esc(f)}</a>`).join(", ")}</td></tr>
<tr><td>DaisySP (Electrosmith, Emilie Gillet) and Rings' sympathetic strings (Emilie Gillet): the PHYS engine's models</td>
  <td>MIT</td><td>in ${src1("firmware/src/phys_dsp.c")}, ${src1("firmware/src/phys_symp.c")}</td></tr>
<tr><td>CrispyZebra by Leo Kuroshita: the PHASE engine's waveforms</td><td>GPL-3.0</td><td>${src1("firmware/src/eng_phase.c")}</td></tr>
<tr><td>klattsch by Tony Gies: design reference for the VOICE engine (no code copied)</td><td>MIT (credit)</td><td></td></tr>
<tr><td>Terminus font (the editor's font, inlined in its page)</td><td>SIL OFL 1.1</td><td><a href="licenses/Terminus-LICENSE.txt">Terminus-LICENSE.txt</a></td></tr>
<tr><td>Fukiai icon font (Hügelton Instruments), the editor's icons</td><td>MIT</td><td><a href="licenses/FUKIAI-LICENSE.txt">FUKIAI-LICENSE.txt</a></td></tr>
</table>
<p>Not in this build: the Felucca Assets that are not under the GPL (the screen's icon atlas: the plugin has no screen, it is
built with <code>FELUCCA_ICONS=0</code>; the Hügelton Sample Pack, which SLOOP does not contain), the JieLi SDK files of the
FM-1 package, the update loader.</p>
<h2>Source</h2>
<p>The complete corresponding source of this build (the firmware, the plugin, the site's build):
<a href="${esc(sourceAt)}">${esc(sourceAt)}</a>. Build it with <code>web/plugin/build.sh</code> (see
<code>web/plugin/README.md</code> there).${dirty ? `</p>
<p class="notice">A development build (preview): it was built from a tree with changes not in that commit.` : ""}</p>
</main></body></html>
`);
put("index.html", `<!doctype html>
<!-- SPDX-License-Identifier: GPL-3.0-only -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>SLOOP plugin for tuttidaw</title>${STYLE}</head><body><main>
<h1>SLOOP plugin for tuttidaw</h1>
<p>SLOOP, the groovebox firmware for the FM-1 by isod89, running in your browser as a <a href="https://tuttidaw.com">tuttidaw</a>
plugin (protocol <code>${PROTOCOL}</code>, manifest <a href="tutti-plugin.json">tutti-plugin.json</a>): its web editor on a
SLOOP of its own, its song rendered into tuttidaw at tuttidaw's tempo.</p>
<p><a href="plugin/">Open it on its own</a> (your work stays in this browser) · <a href="credits.html">credits, licences, source</a></p>
<p class="notice">weavejam's plugin build of SLOOP by isod89. ${esc(NOTICE)}</p>
</main></body></html>
`);
put("icon.svg", `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#000"/><g fill="none" stroke-width="6" stroke-linecap="round"><path d="M14 22h10" stroke="#287cff"/><path d="M14 32h22" stroke="#1ecc70"/><path d="M14 42h16" stroke="#ffc618"/><path d="M40 22v20" stroke="#ff621a"/><circle cx="48" cy="38" r="5" stroke="#ff621a"/></g></svg>\n`);

// ---- the build id, the manifest, the headers
const files = [];
const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
walk(out);
const h = crypto.createHash("sha256");
for (const f of files.map((f) => path.relative(out, f).split(path.sep).join("/")).sort()) {
  h.update(f + "\0");
  h.update(fs.readFileSync(path.join(out, f)));
}
h.update(`channel\0${channel}\0${EMBEDDERS.join(" ")}`);           // (the channel too: its embedders differ)
const build = h.digest("hex").slice(0, 16);
const manifest = {
  protocol: PROTOCOL,
  id: "com.weavejam.sloop",
  name: "SLOOP",
  vendor: "weavejam (SLOOP firmware by isod89)",
  version,
  build,
  license: "GPL-3.0-only",
  source: sourceAt,
  upstream: UPSTREAM,                                  // (not a v0 field: receivers ignore it)
  notice: NOTICE,
  entry: "/plugin/",
  icon: "/icon.svg",
  state: { version: STATE_VERSION, reads: STATE_READS },
  capabilities: {
    ownSequencer: true,
    acceptsMidi: true,
    outputs: OUTPUTS,
    stemsSumToMix: false,
    tempoMap: "constant",
    sampleRates: SAMPLE_RATES,
    seek: false,                                       // every render plays from beat 0 (renderer.js)
    fm1Panel: true,                                    // a hardware FM-1 can play it (protocol 12, fm1-panel.js)
    midiChannels: [{ channel: 0, name: "Track 1" }, { channel: 1, name: "Track 2" }, { channel: 2, name: "Track 3" },
                   { channel: 3, name: "Drums (GM notes)" }],
  },
};
put("tutti-plugin.json", JSON.stringify(manifest, null, 2) + "\n");
put("plugin/build-info.js", `// generated by web/plugin/site.mjs (PLUGIN_CHANNEL=${channel})
export const BUILD = ${JSON.stringify({ id: manifest.id, version, build, source: sourceAt, channel })};
export const EMBEDDERS = ${JSON.stringify(EMBEDDERS)};
`);
// the plugin page's policy: its one inline script (the editor's) by its hash, the rest from this origin only
const inline = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const rest = inline.length === 1 ? page.replace(inline[0][0], "") : page;
if (inline.length !== 1 || /<script(?![^>]*\bsrc=)/.test(rest) || /\son[a-z]+\s*=\s*["']/i.test(rest))
  throw new Error("site: plugin/index.html: one inline script (the editor's) and no inline handlers expected");
const inlineHash = crypto.createHash("sha256").update(inline[0][1], "utf8").digest("base64");
const ANCESTORS = EMBEDDERS.join(" ");
const PAGE_CSP = [`default-src 'none'`, `script-src 'self' 'sha256-${inlineHash}' 'wasm-unsafe-eval'`, `worker-src 'self'`,
                  `connect-src 'self'`, `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`, `img-src 'self' data: blob:`,
                  `media-src 'self' blob:`, `frame-src 'none'`, `form-action 'none'`, `object-src 'none'`, `base-uri 'self'`,
                  `frame-ancestors ${ANCESTORS}`].join("; ");
// (Cloudflare Pages joins the values of every rule matching a path with commas: two policies, both enforced)
put("_headers", `# Cloudflare Pages (web/plugin/site.mjs, PLUGIN_CHANNEL=${channel})
/*
  Content-Security-Policy: frame-ancestors ${ANCESTORS}; object-src 'none'; base-uri 'self'
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
/tutti-plugin.json
  Access-Control-Allow-Origin: *
  Cache-Control: no-cache
  Content-Type: application/json; charset=utf-8
/*.wasm
  Content-Type: application/wasm
/plugin/*
  Content-Security-Policy: ${PAGE_CSP}
/plugin/sloop.wasm
  Content-Type: application/wasm
`);
console.log(`plugin: ${out} (${channel}, ${files.length + 3} files, build ${build}, ${version})`);
