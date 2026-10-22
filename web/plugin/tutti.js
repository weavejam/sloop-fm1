// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page (/plugin/): SLOOP's web editor (web/editor.html, built into this page by site.mjs) on a SLOOP of its
// own (sloop.wasm in an AudioWorklet, worklet-tutti.js) instead of an FM-1 on USB, with tuttidaw's protocol
// (tutti-plugin/0, protocol.js). After Felucca's page (weavejam/Felucca web/plugin/tutti.js). tutti-host.js (before
// the editor's script) gives the editor its MIDI port to this SLOOP.
//   - in tuttidaw's iframe: the handshake; `init` gives the state this SLOOP starts with (no saves in this browser);
//     the host's tempo and transport drive its preview; edits make new state revisions (state-changed); "Render to
//     tuttidaw" sends `commit`; renders run in a Worker (render-worker.js); mode 'render': headless, nothing else runs.
//   - opened by itself (or not connected within a few seconds): the editor on this page's SLOOP, its state kept in
//     this browser, a note that it is a tuttidaw plugin.
import { PluginSession, embedderAllowed } from "./protocol.js";
import { SloopEngine, PreviewTempo } from "./engine.js";
import { RenderError, PLAY_MODE } from "./renderer.js";
import { packState, unpackState, STATE_VERSION, DEFAULT_META, PLAYS, cleanMeta } from "./state.js";
import { BUILD, EMBEDDERS } from "./build-info.js";

const embedded = window.parent !== window;
const host = window.sloopHost;
const WASM_URL = new URL("sloop.wasm", import.meta.url).href;
const STORE_KEY = "sloop-tutti-standalone";            // (opened by itself: the state in this browser)
const log = (...a) => console.debug(...a);
let standalone = !embedded;

// ------------------------------------------------------------------ the page's own parts
const $ = (id) => document.getElementById(id);
const PLAY_NAMES = { auto: "song (if set) or pattern", song: "song (arranger)", pattern: "pattern (loop)",
                     A: "section A (loop)", B: "section B (loop)", C: "section C (loop)", D: "section D (loop)" };
function bar() {
  const el = document.createElement("section");
  el.className = "tutti";
  el.innerHTML = `
    <style>
      .tutti { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: center; padding: 8px 12px; margin: 0 0 8px;
               background: var(--s1); border-bottom: 1px solid var(--line); color: var(--fg2); }
      .tutti b { color: var(--fg); font-weight: 400; }
      .tutti label { display: inline-flex; gap: 6px; align-items: center; }
      .tutti progress { width: 110px; }
      .tutti input[type=range] { width: 110px; }
      .tutti .note { flex-basis: 100%; color: var(--dim); margin: 0; }
      .tutti .credit { flex-basis: 100%; color: var(--dim); font-size: 16px; margin: 0; }
      .tutti [hidden] { display: none !important; }
    </style>
    <b>SLOOP</b><span class="dim">· tuttidaw plugin</span>
    <button id="tt-audio" type="button" class="pri" hidden>start SLOOP (audio)</button>
    <label title="What a render plays (and PLAY with tuttidaw's transport)">render
      <select id="tt-play">${PLAYS.map((p) => `<option value="${p}">${PLAY_NAMES[p]}</option>`).join("")}</select></label>
    <span id="tt-connected" hidden>
      <button id="tt-commit" type="button" class="pri" title="Render SLOOP's song into tuttidaw at tuttidaw's tempo">render to tuttidaw</button>
      <label><input type="checkbox" id="tt-stems"> stems (track 1-3, drums)</label>
    </span>
    <label>volume <input type="range" id="tt-vol" min="0" max="1023" value="724"></label>
    <span id="tt-render" hidden>rendering <progress id="tt-progress" max="1" value="0"></progress></span>
    <p class="note" id="tt-note"></p>
    <p class="credit">SLOOP plugin for <a href="https://tuttidaw.com">tuttidaw</a> by weavejam, built from
      <a href="https://github.com/isod89/sloop-fm1">SLOOP</a> by isod89 (after Felucca by Leo Kuroshita / Hügelton
      Instruments), GPL-3.0 · <a href="../credits.html" target="_blank" rel="noopener">credits, licences, source</a> ·
      source of this build: <span id="tt-source"></span> · not affiliated with or endorsed by M-VAVE or Hügelton
      Instruments.</p>`;
  const main = document.querySelector("main") || document.body;
  main.insertBefore(el, main.firstChild);
  $("tt-source").textContent = BUILD.source;            // (as text too: tuttidaw's frame opens no popups)
  $("tt-play").value = meta.play;
  $("tt-play").addEventListener("change", () => setPlay($("tt-play").value));
  $("tt-vol").addEventListener("input", () => send({ type: "master", k10: +$("tt-vol").value }));
  $("tt-audio").addEventListener("click", () => startAudio());
  $("tt-commit").addEventListener("click", () => commit());
}
const note = (t) => { if ($("tt-note")) $("tt-note").textContent = t; };

// ------------------------------------------------------------------ the live SLOOP (edit mode, standalone)
let ac = null, node = null, wasmBytes = null, ready = false, loads = 0, sigBase = null, waitId = 0, meta = { ...DEFAULT_META };
const waits = new Map();
const status = window.sloopPlugin = { ready: false, playing: false, sig: 0 };   // (what the page's SLOOP does, to look at)
const send = (m, transfer) => { if (node) node.port.postMessage(m, transfer || []); };
const tempo = new PreviewTempo((bpm) => send({ type: "tutti-tempo", bpm }));
const playsSong = (m) => m.play === "auto" || m.play === "song";

// the editor's MIDI to this SLOOP (tutti-host.js), once it runs
function backend(d) {
  if (d[0] === 0xF0) send({ type: "sysex", data: d });
  else send({ type: "midi", data: d });
}
// the editor (re)connected to a fresh SLOOP: what it shows is read again
let connecting = null;
async function connectEditor() {
  const ed = host.editor;
  if (!ed || !ready) return;
  if (connecting) return connecting;
  connecting = (async () => {
    try {
      if (ed.connected()) ed.disconnect();
      await ed.connect();
    } finally { connecting = null; }
  })();
  return connecting;
}
host.onEditor = () => connectEditor();

function ask(type, extra = {}) {
  const id = ++waitId;
  return new Promise((res, rej) => {
    waits.set(id, res);
    send({ type, id, ...extra });
    setTimeout(() => { if (waits.delete(id)) rej(new RenderError("internal", "SLOOP did not answer")); }, 5000);
  });
}

function onNode(e) {
  const m = e.data;
  if (m.type === "sysex") host.receive(m.data);
  else if (m.type === "ready") {
    ready = status.ready = true;
    sigBase = m.sig;
    host.backend = backend;
    for (const d of host.waiting.splice(0)) backend(d);
    tempo.reset();
    tempo.at(0);
    connectEditor();
  } else if (m.type === "playing") status.playing = m.on;
  else if (m.type === "tutti-sig") {
    if (sigBase !== null && m.sig !== sigBase) changed();
    sigBase = status.sig = m.sig;
  } else if (m.type === "tutti-snapshot" || m.type === "tutti-beats") {
    const w = waits.get(m.id);
    waits.delete(m.id);
    if (w) w(m);
  } else if (m.type === "error") {
    note(`SLOOP: ${m.message}`);
    console.error("sloop worklet:", m.message);
  }
}

async function ensureAudio() {
  if (ac) return;
  ac = new AudioContext({ sampleRate: 44100, latencyHint: "interactive" });
  await ac.audioWorklet.addModule(new URL("./worklet-tutti.js", import.meta.url));
  node = new AudioWorkletNode(ac, "sloop-tutti", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
  node.port.onmessage = onNode;
  node.onprocessorerror = () => note("SLOOP's audio stopped (reload the page).");
  node.connect(ac.destination);
  if (!wasmBytes) {
    const res = await fetch(WASM_URL);
    if (!res.ok) throw new Error(`sloop.wasm: ${res.status}`);
    wasmBytes = await res.arrayBuffer();
  }
}
// the browser lets a page play sound after a gesture: SLOOP runs (its clock is the audio's) once the context runs
function audioState() {
  const on = ac && ac.state === "running";
  if ($("tt-audio")) $("tt-audio").hidden = !ac || on;
  if (ac && !on) note("Press “start SLOOP” (the browser waits for a click before a page plays sound).");
  else if (on && /start SLOOP/.test($("tt-note") ? $("tt-note").textContent : "")) note("");
}
async function startAudio() {
  if (!ac) return;
  try { await ac.resume(); } catch {}
  audioState();
}
for (const ev of ["pointerdown", "keydown"]) window.addEventListener(ev, () => { if (ac && ac.state !== "running") startAudio(); }, true);

let current = { sectors: {}, meta: { ...DEFAULT_META } };
const live = {
  async load(state, context) {
    loads++;
    current = state;
    meta = cleanMeta(state.meta);
    if ($("tt-play")) $("tt-play").value = meta.play;
    this.context(context);
    ready = status.ready = false;
    host.backend = null;
    await ensureAudio();
    const first = !node.loaded;
    node.loaded = true;
    send({ type: "load", wasm: first ? wasmBytes.slice(0) : null, state, master: +($("tt-vol") ? $("tt-vol").value : 724),
           song: playsSong(meta) });
    if (ac.state !== "running") { try { await ac.resume(); } catch {} }
    ac.onstatechange = audioState;
    audioState();
  },
  async snapshot() {
    if (!node || !ready) return { sectors: current.sectors, meta: { ...meta } };   // (not on yet: nothing changed)
    const load = loads;
    const m = await ask("tutti-snapshot");
    if (!m.ok) throw new RenderError("internal", "SLOOP could not save its state");
    if (load !== loads) return { sectors: m.sectors, meta: { ...meta } };   // (a state loaded since: it stays)
    sigBase = m.sig;
    current = { sectors: m.sectors, meta: { ...meta } };
    return current;
  },
  context(ctx) { tempo.context(ctx); },
  transport(t) {
    if (!node || !ac) return;
    tempo.at(t.beat);
    if (!t.playing) { send({ type: "tutti-play", gen: t.generation, playing: false }); return; }
    // the context frame heard at atEpochMs: by the output's timestamp (it has the output latency) where there is one
    let atCtx;
    const ts = ac.getOutputTimestamp ? ac.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) atCtx = ts.contextTime + (t.atEpochMs - (performance.timeOrigin + ts.performanceTime)) / 1000;
    else atCtx = ac.currentTime + (t.atEpochMs - (performance.timeOrigin + performance.now())) / 1000 - (ac.outputLatency || ac.baseLatency || 0);
    send({ type: "tutti-play", gen: t.generation, playing: true, atFrame: Math.round(atCtx * ac.sampleRate),
           pos: Math.round((t.beat * 60 / tempo.bpm) * 44100) });
  },
  close() { send({ type: "tutti-play", gen: -1, playing: false }); },
};

// what a render plays (the state's meta): a change is a change of the state
function setPlay(p) {
  meta = cleanMeta({ ...meta, play: p });
  send({ type: "song", on: playsSong(meta) });
  changed();
}

// the state changed: a new revision for the session; opened by itself, kept in this browser (once still for 1.5 s)
let saveTimer = 0;
function changed() {
  if (standalone) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 1500);
  } else engine.changed();
}
async function saveLocal() {
  try {
    const st = await live.snapshot();
    const u8 = new Uint8Array(packState(st));
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    localStorage.setItem(STORE_KEY, btoa(bin));
  } catch (err) { log("sloop: not saved in this browser", err); }
}
function loadLocal() {
  try {
    const b = localStorage.getItem(STORE_KEY);
    if (!b) return null;
    const bin = atob(b), u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return unpackState(u8.buffer, STATE_VERSION);
  } catch { return null; }
}

// Render to tuttidaw: the range one pass of what plays takes (the song's bars, or the pattern's), the stems if asked
async function commit() {
  let toBeat;
  try { toBeat = (await ask("tutti-beats", { mode: PLAY_MODE[meta.play] })).beats; } catch {}
  const outputs = $("tt-stems").checked ? ["mix", "t1", "t2", "t3", "drums"] : ["mix"];
  session.commit(toBeat > 0 ? { fromBeat: 0, toBeat, outputs } : { outputs });
}

// ------------------------------------------------------------------ renders in a Worker
// one render at a time in it: one still running when another starts (its session ended meanwhile: it is let go, not
// waited for) goes with its worker, and the new one gets a fresh worker. The session's end (close, the port's
// messageerror) or a message between it and the page that cannot be read (messageerror, either way): the worker's work
// ended with it (stopWorker)
let worker = null, workerBusy = null;
function stopWorker(err = new RenderError("cancelled", "the session ended")) {
  if (worker && workerBusy) {
    worker.terminate();
    workerBusy(err);
    worker = null;
  }
}
function renderInWorker(state, req, sink) {
  // (an ended session's render, its state made late: it never touches the worker, the next session's render may be in it)
  if (sink.cancelled()) return Promise.reject(new RenderError("cancelled", "cancelled"));
  stopWorker();
  worker = worker || new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
  const w = worker;
  if ($("tt-render")) { $("tt-render").hidden = false; $("tt-progress").value = 0; }
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => { if (sink.cancelled()) w.postMessage({ type: "cancel" }); }, 50);
    const end = () => { clearInterval(poll); w.onmessage = w.onmessageerror = null; workerBusy = null; if ($("tt-render")) $("tt-render").hidden = true; };
    const unreadable = () => {                         // (the session ends: its teardown stops this worker, see close)
      log("tutti: a render worker message could not be read");
      session.close();
      stopWorker(new RenderError("internal", "a render worker message could not be read"));
    };
    w.onmessageerror = unreadable;
    workerBusy = (err) => { end(); reject(err); };
    w.onmessage = async (e) => {
      const m = e.data;
      if (m.type === "chunk") {
        try {
          await sink.chunk(m.output, m.frameOffset, m.channels);
          w.postMessage({ type: "ack" });
        } catch {
          w.postMessage({ type: "cancel" });
        }
      } else if (m.type === "progress") {
        if ($("tt-progress")) $("tt-progress").value = m.fraction;
        sink.progress(m.fraction);
      } else if (m.type === "done") { end(); resolve(m.result); }
      else if (m.type === "error") { end(); reject(new RenderError(m.code, m.message)); }
      else if (m.type === "messageerror") unreadable();
    };
    w.onerror = (e) => { end(); worker = null; w.terminate(); reject(new RenderError("internal", e.message || "the render worker failed")); };
    w.postMessage({ type: "render", wasmUrl: WASM_URL, state, req });
  });
}

// ------------------------------------------------------------------ the session
const engine = new SloopEngine({
  render: renderInWorker,
  live,
  onChanged: (rev) => session.stateChanged(rev),
});
const session = new PluginSession({
  engine,
  post: (m) => window.parent.postMessage(m, "*"),
  allow: (origin) => embedderAllowed(origin, EMBEDDERS),   // (the build's channel: site.mjs PLUGIN_CHANNEL)
  plugin: { id: BUILD.id, version: BUILD.version, build: BUILD.build },
  log,
});
const initOrig = engine.init.bind(engine);
engine.init = async (args) => {
  clearTimeout(alone);
  if (args.mode === "render") note("Rendering for tuttidaw (headless).");   // (no SLOOP, no sound: only renders)
  else {
    $("tt-connected").hidden = false;
    note("Connected to tuttidaw.");
  }
  return initOrig(args);
};

function becomeStandalone() {
  standalone = true;
  session.stopAccepting();                             // (a late connect would find SLOOP on this browser's state)
  note("This is the SLOOP plugin for tuttidaw. Opened by itself it is SLOOP in your browser: its state stays in this browser.");
  const st = loadLocal() || { sectors: {}, meta: { ...DEFAULT_META } };
  live.load(st, null).catch((err) => note(`SLOOP: ${err.message || err}`));
}

bar();
engine.close = () => {                                 // (the session's end: the live SLOOP stopped, a render's worker too)
  stopWorker();
  live.close();
};

let alone = 0;
if (embedded) {
  note("Waiting for tuttidaw…");
  // the host lays the frame out: the size this page wants, once connected and whenever it changes
  const size = () => session.resize(Math.min(1600, document.documentElement.scrollWidth), Math.min(1200, document.documentElement.scrollHeight));
  window.addEventListener("message", (e) => {
    if (session.onWindowMessage({ data: e.data, origin: e.origin, isParent: e.source === window.parent, ports: e.ports })) {
      note("Connected to tuttidaw.");
      size();
    }
  });
  session.hello();
  alone = setTimeout(() => { if (!session.port) becomeStandalone(); }, 4000);   // (not tuttidaw's frame)
  new ResizeObserver(size).observe(document.body);
} else becomeStandalone();
window.addEventListener("pagehide", () => { if (standalone && ready) saveLocal(); session.close(); });
