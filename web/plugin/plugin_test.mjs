// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The SLOOP plugin (web/plugin) in Node, after Felucca's (weavejam/Felucca web/plugin/plugin_test.mjs): SLOOP made and
// edited the way the plugin page does it (the editor's own protocol code, web/editor.html PROTO, over the device's
// SysEx), the renderer against the wasm, and the protocol against a fake host over a MessageChannel (protocol-v0 11,
// the plugin's side).
//   node web/plugin/plugin_test.mjs [build/plugin-wasm/sloop.wasm]
// FAST=1 skips the slow checks (64 bars, 48 kHz quality).
import fs from "fs";
import os from "os";
import path from "path";
import vm from "vm";
import crypto from "crypto";
import { spawnSync, execSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { render, planRender, midiEvents, device, frameAt, PLAY_MODE, MIN_BPM, MAX_BPM } from "./renderer.js";
import { packState, unpackState, stateEquals, storeSectors, restoreSectors, STATE_VERSION, DEFAULT_META } from "./state.js";
import { PluginSession, embedderAllowed, CHANNELS, PROTOCOL, INITIAL_CREDITS } from "./protocol.js";
import { SloopEngine, PreviewTempo } from "./engine.js";
import { Resampler } from "./resample.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const wasmPath = process.argv[2] || path.join(ROOT, "build/plugin-wasm/sloop.wasm");
const mod = await WebAssembly.compile(fs.readFileSync(wasmPath));
const FAST = process.env.FAST === "1";
let fails = 0;
const check = (what, ok) => { console.log(`plugin: ${what.padEnd(84)} ${ok ? "ok" : "FAIL"}`); if (!ok) fails++; };
const tm = (bpm, more = []) => ({ tempoPoints: [{ beat: 0, bpm, ramp: "step" }, ...more], signatures: [{ beat: 0, numerator: 4, denominator: 4 }] });
const ctxOf = (bpm, more) => ({ timeMap: tm(bpm, more), key: null });
const req = (o) => ({ renderId: "r", stateRevision: 1, context: ctxOf(120), input: null, fromBeat: 0, toBeat: 8, tailMs: 0,
                      outputs: ["mix"], sampleRate: 44100, ...o });
const peak = (a) => a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const rms = (a) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / Math.max(1, a.length));
const db = (x) => (20 * Math.log10(x)).toFixed(1);
const same = (a, b) => a.length === b.length && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
const ALL = ["mix", "t1", "t2", "t3", "drums"];
const NOTHING = { notes: [], cc: [], pitchBend: [], preRollBeats: 0 };

// ---- the editor's protocol code (web/editor.html, between PROTO-BEGIN and PROTO-END), as the plugin page runs it
const html = fs.readFileSync(path.join(ROOT, "web/editor.html"), "utf8");
const E = vm.runInNewContext(html.slice(html.indexOf("/*PROTO-BEGIN*/"), html.indexOf("/*PROTO-END*/")) +
  ";({ CMD, req, frame, unframe, parse, LIVE, ARR, crc32, backupCapture, buildSlot })",
  { setTimeout, clearTimeout, setInterval, clearInterval, console, TextEncoder, TextDecoder, Blob, Response, DecompressionStream });

// a live SLOOP (the page's: not headless), driven over its SysEx as the editor drives it
class Dev {
  static async make(state = { sectors: {} }) {
    const { exports: ex } = await WebAssembly.instantiate(mod, {});
    ex._initialize();
    ex.dev_nor_erase();
    restoreSectors(new Uint8Array(ex.memory.buffer, ex.dev_nor(), ex.dev_nor_size()), state.sectors);
    ex.tutti_boot(0);
    return new Dev(ex);
  }
  constructor(ex) { this.ex = ex; }
  // one request, its reply ({cmd, a}): the device answers at once (sloop_plugin.c dev_sysex runs ed_service)
  raw([cmd, a]) {
    const ex = this.ex, f = Uint8Array.from(E.frame(cmd, a));
    new Uint8Array(ex.memory.buffer).set(f, ex.dev_sysex_in());
    for (let i = 0; !ex.dev_sysex(f.length); i++) { if (i > 100) throw new Error("busy"); this.run(5); }
    const n = ex.dev_sysex_out_len(), d = new Uint8Array(ex.memory.buffer, ex.dev_sysex_out(), n).slice();
    ex.dev_sysex_clear();
    const frames = [];
    let cur = [];
    for (const b of d) { cur.push(b); if (b === 0xF7) { frames.push(E.unframe(Uint8Array.from(cur))); cur = []; } }
    const r = frames.find((x) => x && x.cmd === cmd);
    if (!r) throw new Error(`no reply to ${cmd}`);
    return r;
  }
  rq(r) { const x = this.raw(r); return E.parse[x.cmd] ? E.parse[x.cmd](x.a) : x.a; }
  run(ms) { for (let k = 0; k < ms * 44.1; k += 128) this.ex.dev_render(128); }
  // synth track k: notes (or [] for a rest) on steps
  steps(k, list) { for (const [i, notes, vel = 100] of list) this.rq(E.req.trackStep(k, i, { n: notes.length, notes: [...notes, 0, 0, 0, 0].slice(0, 4), time: notes.length ? 0 : 2, flags: 0, vel })); }
  // the drum track: lanes on steps
  drums(list) {
    for (const [i, lanes] of list) {
      let on = 0;
      for (const l of lanes) on |= 1 << l;
      this.rq(E.req.drumStep(i, { on, lvl: new Array(16).fill(0), rat: new Array(16).fill(0) }));
    }
  }
  clearAll(len = 16) { for (let k = 0; k < 3; k++) this.steps(k, Array.from({ length: len }, (_, i) => [i, []])); this.drums(Array.from({ length: len }, (_, i) => [i, []])); }
  saveSection(s) { const r = this.rq(E.req.project(1, s)); if (!r.used) throw new Error(`section ${s} not saved`); }
  settings() {
    const L = this.rq(E.req.bkList()), it = L.items.find((x) => x.id === 1), d = new Uint8Array(it.len);
    for (let off = 0; off < it.len; off += 256) d.set(this.rq(E.req.bkGet(1, off, Math.min(256, it.len - off))).data, off);
    return d;
  }
  put(id, d) {
    let r = this.rq(E.req.bkBegin(id, d.length, E.crc32(d)));
    if (r.rc) throw new Error(`begin ${id} rc ${r.rc}`);
    for (let off = 0; off < d.length; off += 256) {
      r = this.rq(E.req.bkData(id, off, d.subarray(off, off + 256)));
      if (r.rc) throw new Error(`data ${id} rc ${r.rc}`);
    }
    r = this.rq(E.req.bkCommit(id));
    if (r.rc) throw new Error(`commit ${id} rc ${r.rc}`);
  }
  // the song order (the editor's Song page): [[section 0..3, bars], ...]
  song(entries, loop = false) { this.put(1, E.ARR.encode(this.settings(), { loop, entries: entries.map(([scene, bars]) => ({ scene, bars })) })); }
  // the state as the page gives it (tutti_snapshot, the storage sectors) with the plugin's meta
  state(meta = DEFAULT_META) {
    if (!this.ex.tutti_snapshot()) throw new Error("snapshot failed");
    return { sectors: storeSectors(new Uint8Array(this.ex.memory.buffer, this.ex.dev_nor(), this.ex.dev_nor_size())), meta: { ...meta } };
  }
  // every object of the editor's backup (the device's own BK_LIST / BK_GET): what a user has made
  async backup() {
    const rq = async (r) => this.raw(r).a;
    const f = await E.backupCapture(rq, { version: "test" });
    return Object.fromEntries(f.objects.map((o) => [o.id, o.data]));
  }
}

// a whole render into one array per output channel
async function renderAll(state, r, opts) {
  const out = {}, offs = {};
  const res = await render(mod, state, r, {
    chunk: async (o, off, ch) => {
      if ((offs[o] ?? 0) !== off) throw new Error(`chunk of ${o} at ${off}, expected ${offs[o] ?? 0}`);
      offs[o] = off + ch[0].length;
      (out[o] ||= []).push(ch);
    },
    progress: () => {}, cancelled: () => false,
  }, opts);
  const cat = (parts, c) => { const n = parts.reduce((s, p) => s + p[c].length, 0), a = new Float32Array(n); let k = 0; for (const p of parts) { a.set(p[c], k); k += p[c].length; } return a; };
  return { res, out: Object.fromEntries(Object.entries(out).map(([o, p]) => [o, [cat(p, 0), cat(p, 1)]])) };
}
const pk = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.max(peak(v[0]), peak(v[1]))]));

// ---- the music the tests play, made as the editor makes it
// "groove": a 16-step loop on all four tracks (the default sounds), the working pattern
const groove = await (async () => {
  const d = await Dev.make();
  d.steps(0, [[0, [36]], [4, [36]], [8, [43]], [12, [41]]]);
  d.steps(1, [[0, [60, 64, 67]], [8, [62, 65, 69]]]);
  d.steps(2, [0, 2, 4, 6, 8, 10, 12, 14].map((i) => [i, [72 + (i % 6)]]));
  d.drums([[0, [0, 4]], [2, [4]], [4, [2, 4]], [6, [4]], [8, [0, 4]], [10, [4]], [12, [2, 4]], [14, [4, 5]]]);
  return { dev: d, state: d.state() };
})();
// "song": section A = track 1 only (8 steps), B = drums only; the song: A 2 bars, B 1 bar (12 beats), no loop; the
// working pattern: track 3 only
const songDev = await Dev.make();
songDev.clearAll();
songDev.steps(0, [[0, [48]], [2, [55]], [4, [48]], [6, [55]]]);
songDev.rq(E.req.trackParam(0, 29, 8));                                // (P_SLEN 8: a half-bar loop)
songDev.saveSection(0);
songDev.clearAll();
songDev.drums([[0, [0]], [4, [2]], [8, [0]], [12, [2]]]);
songDev.saveSection(1);
songDev.clearAll();
songDev.steps(2, [[0, [79]], [8, [79]]]);
songDev.song([[0, 2], [1, 1]]);
const song = songDev.state({ play: "song" });

// ---- determinism
for (const sr of [44100, 48000]) {
  const r = req({ outputs: ALL, sampleRate: sr, toBeat: 6, tailMs: 300 });
  const x = await renderAll(groove.state, r), y = await renderAll(groove.state, r);
  check(`${sr} Hz: two renders (mix + 4 stems), byte for byte the same (fresh instances)`,
        ALL.every((o) => same(x.out[o][0], y.out[o][0]) && same(x.out[o][1], y.out[o][1])) && peak(x.out.mix[0]) > 0.05);
}

// ---- geometry (protocol 5): exact frame counts, all outputs one length, frame 0 = fromBeat
for (const [bpm, from, to, tail, sr] of [[120, 0, 8, 0, 44100], [123.45, 4, 13.5, 250, 44100], [123.45, 1, 9, 100, 48000], [97, 0, 4, 10000, 48000]]) {
  const r = req({ context: ctxOf(bpm), fromBeat: from, toBeat: to, tailMs: tail, sampleRate: sr, outputs: ALL });
  const want = Math.round((to * 60 / bpm) * sr) - Math.round((from * 60 / bpm) * sr) + Math.ceil(tail * sr / 1000);
  const { out } = await renderAll(groove.state, r);
  check(`${bpm} BPM [${from}, ${to}) + ${tail} ms at ${sr}: ${want} frames in each of 5 outputs`, ALL.every((o) => out[o][0].length === want && out[o][1].length === want));
}
{ // a later start is the same audio as the frames of a render from 0 (every render plays from the song's start)
  const a = (await renderAll(groove.state, req({ context: ctxOf(123.45), fromBeat: 0, toBeat: 12 }))).out.mix[0];
  const b = (await renderAll(groove.state, req({ context: ctxOf(123.45), fromBeat: 5.5, toBeat: 12 }))).out.mix[0];
  const off = Math.round((5.5 * 60 / 123.45) * 44100);
  check(`[5.5, 12) at 123.45 BPM is [0, 12)'s frames from ${off} on, bit for bit`, same(a.subarray(off, off + b.length), b));
}
{ // a tempo map with a change before the range: frame(beat) integrates it, the range at its own tempo
  const ctx = { timeMap: tm(100, [{ beat: 8, bpm: 140, ramp: "step" }]), key: null };
  const p = planRender(req({ context: ctx, fromBeat: 8, toBeat: 16 }));
  const f = (b) => frameAt(ctx.timeMap.tempoPoints, b, 44100);
  check(`a change at beat 8 (100 -> 140): [8, 16) is ${p.frames} = frame(16) - frame(8) frames at 140`,
        p.bpm === 140 && p.frames === f(16) - f(8) && f(8) === Math.round(8 * 60 / 100 * 44100));
  let code = null;
  try { planRender(req({ context: ctx, fromBeat: 4, toBeat: 12 })); } catch (e) { code = e.code; }
  const ap = planRender(req({ context: ctx, fromBeat: 4, toBeat: 12, approximation: "start-tempo" }));
  check("a change inside the range: 'unsupported'; with approximation 'start-tempo' at the tempo at fromBeat",
        code === "unsupported" && ap.bpm === 100 && ap.frames === Math.round(12 * 0.6 * 44100) - Math.round(4 * 0.6 * 44100));
  const ramp = { timeMap: tm(120, []), key: null };
  ramp.timeMap.tempoPoints = [{ beat: 0, bpm: 120, ramp: "linear" }, { beat: 4, bpm: 60, ramp: "step" }];
  const sec = frameAt(ramp.timeMap.tempoPoints, 4, 44100) / 44100, ideal = 60 * 4 / (60 - 120) * Math.log(60 / 120);
  check(`a linear ramp 120 -> 60 over 4 beats: ${sec.toFixed(4)} s (the integral: ${ideal.toFixed(4)} s)`, Math.abs(sec - ideal) < 1 / 44100);
  const ctx2 = { timeMap: tm(100, [{ beat: 3.3, bpm: 137.7, ramp: "step" }]), key: null };
  const p2 = planRender(req({ context: ctx2, fromBeat: 5, toBeat: 9.1, approximation: "start-tempo" }));
  const own = (b) => Math.round(b * 60 / 137.7 * 44100);
  check(`'start-tempo' lengths from the constant map at the start tempo: ${p2.frames} = own(9.1) - own(5)`, p2.frames === own(9.1) - own(5));
}
{ // the tempo range: SLOOP's (40 .. 240 BPM), outside it 'unsupported', never a silently different tempo
  const code = (bpm, more) => { try { planRender(req({ context: ctxOf(bpm, more) })); return "ok"; } catch (e) { return e.code; } };
  const ex = await device(mod, {}, 120);
  check(`tempo: ${MIN_BPM} and ${MAX_BPM} BPM render; 39.99, 240.01, 300 and 10 BPM: unsupported; the wasm's range the same`,
        code(40) === "ok" && code(240) === "ok" && code(39.99) === "unsupported" && code(240.01) === "unsupported" &&
        code(300) === "unsupported" && code(10) === "unsupported" && code(120, [{ beat: 16, bpm: 400, ramp: "step" }]) === "ok" &&
        ex.tutti_bpm_min() === MIN_BPM && ex.tutti_bpm_max() === MAX_BPM && ex.tutti_tempo(300) === 0 && ex.tutti_tempo(39) === 0 &&
        ex.tutti_tempo(123.45) === 1);
}
{ // progress (protocol 6, no seek): over the pre-roll from beat 0 and the range, monotonic, to 1
  const seen = [];
  let chunks = 0;
  await render(mod, groove.state, req({ fromBeat: 24, toBeat: 32 }), {
    chunk: async () => { chunks++; }, progress: (f) => seen.push([f, chunks]), cancelled: () => false });
  const before = Math.max(...seen.filter(([, c]) => c === 0).map(([f]) => f));
  check(`progress over pre-roll + range: ${seen.length} steps, ${before.toFixed(3)} (pre-roll 0.75) before the first chunk, then to 1`,
        seen.every(([f], i) => f >= 0 && f <= 1 && (!i || f >= seen[i - 1][0])) && before > 0.6 && before <= 0.75 &&
        seen.at(-1)[0] === 1 && seen.filter(([, c]) => c === 0).length > 3);
}

// ---- fractional tempo: the transport clock (sloop_plugin.c tutti_clk_*) against the ideal grid, and the sound
if (!FAST) {
  const clock = async (bpm, nbars) => {                // the frame each bar starts at, from the clock (units: a sample at
    const ex = await device(mod, {}, bpm);             // 1 BPM, core.h), between the block starts it is read at
    ex.tutti_mode(PLAY_MODE.pattern);
    ex.tutti_start(0xFFFFFFFF);
    const BAR = 4 * 44100 * 60, got = [0];
    let f = 0, u0 = 0;
    ex.tutti_render(1, 0);                             // (the transport starts with the first block: units 0 at frame 0)
    f = 32;
    u0 = ex.tutti_clk_beat() * 44100 * 60 + ex.tutti_clk_pos();
    while (got.length <= nbars) {
      ex.tutti_render(1, 0);
      const u1 = ex.tutti_clk_beat() * 44100 * 60 + ex.tutti_clk_pos(), k = got.length;
      if (u1 >= k * BAR) got.push(f + (k * BAR - u0) * 32 / (u1 - u0));   // (the bar line inside this block)
      u0 = u1;
      f += 32;
    }
    return got;
  };
  const bpm = 123.45, got = await clock(bpm, 64);
  const err = got.map((f, k) => f - (k * 4 * 60 / bpm) * 44100), worst = Math.max(...err.map(Math.abs));
  check(`123.45 BPM: 64 bars' starts on the clock each within 1 sample of the ideal (worst ${worst.toFixed(4)}, bar 64 at ${got[64].toFixed(2)})`, worst < 1);
  // the sound: a kick on every bar's first step; bar 64's kick against bar 0's, the ideal distance (the firmware takes
  // its steps per block of 32 frames: the same block offset as bar 0's, within a block)
  const d = await Dev.make();
  d.clearAll();
  d.drums([[0, [0]]]);
  const st = d.state({ play: "pattern" });
  const F64 = 64 * 4 * 60 / bpm * 44100;
  const { out } = await renderAll(st, req({ context: ctxOf(bpm), fromBeat: 255.5, toBeat: 256.5, outputs: ["mix"] }));
  const from = Math.round(255.5 * 60 / bpm * 44100), onset = from + out.mix[0].findIndex((x) => Math.abs(x) > 1e-3);
  const head = (await renderAll(st, req({ context: ctxOf(bpm), fromBeat: 0, toBeat: 0.5, outputs: ["mix"] }))).out.mix[0].findIndex((x) => Math.abs(x) > 1e-3);
  check(`123.45 BPM: bar 64's kick at frame ${onset} (ideal bar line ${F64.toFixed(2)}, bar 0's kick at ${head}): within a block`,
        onset - head >= Math.floor(F64) - 32 && onset - head <= Math.ceil(F64) + 32 && head >= 0 && head < 32);
}

// ---- stems
{
  const two = await Dev.make({ sectors: groove.state.sectors });
  two.steps(2, Array.from({ length: 16 }, (_, i) => [i, []]));       // track 3 emptied
  const st = two.state();
  const { out } = await renderAll(st, req({ outputs: ALL, toBeat: 8, tailMs: 500 }));
  const p = pk(out);
  check(`stems: track 1, 2 and the drums sound (${["t1", "t2", "drums"].map((o) => p[o].toFixed(3)).join(" ")}), track 3 (empty) silent (${p.t3})`,
        p.t1 > 1e-3 && p.t2 > 1e-3 && p.drums > 0.01 && p.t3 === 0);
  const sumErr = [0, 1].map((c) => {
    const e = new Float32Array(out.mix[c].length);
    for (let i = 0; i < e.length; i++) e[i] = out.mix[c][i] - out.t1[c][i] - out.t2[c][i] - out.t3[c][i] - out.drums[c][i];
    return rms(e) / rms(out.mix[c]);
  });
  console.log(`plugin:   (mix - (t1 + t2 + t3 + drums): ${db(sumErr[0])} / ${db(sumErr[1])} dB of the mix, L / R: the knee, the buses' saturation)`);
  check("stems add up to the mix within -20 dB (best effort: README)", sumErr.every((x) => x < 0.1));
  const solo = (await renderAll(st, req({ outputs: ["t1"], toBeat: 8, tailMs: 500 }))).out.t1;
  check("a stem rendered alone is the same as with the mix and the other stems", same(solo[0], out.t1[0]) && same(solo[1], out.t1[1]));
}

// ---- use A: the sequencer stops at toBeat, the tail only rings out
{
  const d = await Dev.make({ sectors: groove.state.sectors });
  for (let k = 0; k < 3; k++) d.steps(k, Array.from({ length: 16 }, (_, i) => [i, []]));
  const drums = d.state();
  const a = (await renderAll(drums, req({ toBeat: 4, tailMs: 2000 }))).out.mix[0];
  const b = (await renderAll(drums, req({ toBeat: 12, tailMs: 0 }))).out.mix[0];
  const s = Math.round(4 * 0.5 * 44100) + 22050, e = s + 44100;       // 0.5 .. 1.5 s after toBeat
  const ta = peak(a.subarray(s, e)), tb = peak(b.subarray(s, e));
  check(`use A: after toBeat no new steps, the tail rings out (${ta.toFixed(4)} vs playing on ${tb.toFixed(3)})`,
        same(a.subarray(0, 88200 - 32), b.subarray(0, 88200 - 32)) && tb > 0.05 && ta < tb / 10);
}

// ---- the song (the arranger): its sections in order, its length, then silence; the pattern and a section alone
{
  const bars = (() => { const ex = songDev.ex; return [ex.tutti_play_beats(PLAY_MODE.song), ex.tutti_play_beats(PLAY_MODE.pattern), ex.tutti_play_beats(PLAY_MODE.A), ex.tutti_play_beats(PLAY_MODE.B)]; })();
  check(`the song's length: A 2 bars + B 1 bar = ${bars[0]} beats (pattern ${bars[1]}, section A ${bars[2]}, B ${bars[3]})`,
        bars.join() === "12,4,4,4");
  const { out } = await renderAll(song, req({ outputs: ALL, toBeat: 20, tailMs: 0 }));
  const at = (b) => Math.round(b * 0.5 * 44100), win = (o, b0, b1) => peak(out[o][0].subarray(at(b0), at(b1)));
  const t1A = win("t1", 0, 7.8), drA = win("drums", 0, 7.8), drB = win("drums", 8.1, 11.9), t1B = win("t1", 8.6, 11.9);
  const after = peak(out.mix[0].subarray(at(13.5), at(20))), t3 = win("t3", 0, 20);
  check(`song: bars 1-2 section A (track 1 ${t1A.toFixed(3)}, drums ${drA}), bar 3 section B (drums ${drB.toFixed(3)}, track 1 ${t1B.toFixed(4)})`,
        t1A > 0.01 && drA === 0 && drB > 0.05 && t1B < t1A / 20);
  check(`song: done after its 12 beats (the mix from beat 13.5: ${after.toFixed(5)}); the working pattern (track 3) never plays (${t3})`,
        after < 1e-3 && t3 === 0);
  const p = (play) => ({ sectors: song.sectors, meta: { play } });
  const pat = pk((await renderAll(p("pattern"), req({ outputs: ALL, toBeat: 8 }))).out);
  const secB = pk((await renderAll(p("B"), req({ outputs: ALL, toBeat: 8 }))).out);
  const auto = (await renderAll(p("auto"), req({ outputs: ["mix"], toBeat: 20 }))).out.mix[0];
  check(`play "pattern": the working pattern (track 3 ${pat.t3.toFixed(3)}, nothing else); "B": section B looped (drums ${secB.drums.toFixed(3)} only)`,
        pat.t3 > 0.01 && pat.t1 === 0 && pat.drums === 0 && secB.drums > 0.05 && secB.t1 === 0 && secB.t3 === 0);
  check(`play "auto" with a song: the song`, same(auto, out.mix[0]));
  const noSong = await Dev.make();
  noSong.steps(0, [[0, [60]]]);
  const ns = pk((await renderAll(noSong.state({ play: "auto" }), req({ outputs: ["t1"], toBeat: 8 }))).out);
  check(`play "auto" without a valid song (the default order, no sections): the working pattern (${ns.t1.toFixed(3)})`, ns.t1 > 0.01 && noSong.ex.tutti_play_beats(0) === 4);
}

// ---- use B: the host's MIDI on channels 0..3 (track 1..3, the drums), the sequencer and the arranger never run
{
  const input = { notes: [{ beat: 1, lengthBeats: 1, pitch: 60, velocity: 100, channel: 0 }, { beat: 2.5, lengthBeats: 10, pitch: 67, velocity: 90, channel: 0 }],
                  cc: [{ beat: 0, channel: 0, cc: 1, value: 0 }], pitchBend: [{ beat: 0, channel: 0, value: 0 }], preRollBeats: 0 };
  const { out } = await renderAll({ sectors: {} }, req({ input, toBeat: 4, tailMs: 200, outputs: ["mix", "t1", "t2"] }));
  const l = out.mix[0], at = l.findIndex((x) => Math.abs(x) > 1e-4), want = Math.round(1 * 0.5 * 44100);
  check(`use B: a note at beat 1 (frame ${want}) sounds at frame ${at}: the nearest block, within 16 frames (latency compensated)`, Math.abs(at - want) <= 17);
  check("use B: before it silence, track 1's stem has it, track 2's nothing", peak(l.subarray(0, want - 17)) === 0 && peak(out.t1[0]) > 0.01 && peak(out.t2[0]) === 0);
  const held = (await renderAll({ sectors: {} }, req({ input, toBeat: 3, tailMs: 0 }))).out.mix[0];
  const late = (await renderAll({ sectors: {} }, req({ input, fromBeat: 2.75, toBeat: 3, tailMs: 0 }))).out.mix[0];
  check("use B: a note held over fromBeat sounds from its first frame (rendered from the song's start)",
        same(held.subarray(held.length - late.length), late) && peak(late.subarray(0, 64)) > 1e-3);
}
{ // each channel its part: 0..2 the synth tracks, 3 the drums (GM notes); 4.. nothing
  const one = (channel, pitch) => ({ ...NOTHING, notes: [{ beat: 1, lengthBeats: 1, pitch, velocity: 110, channel }] });
  const rows = [];
  for (const [ch, pitch, want] of [[0, 60, "t1"], [1, 64, "t2"], [2, 67, "t3"], [3, 38, "drums"], [3, 42, "drums"], [5, 60, null]]) {
    const p = pk((await renderAll(song, req({ input: one(ch, pitch), outputs: ALL, toBeat: 4, tailMs: 300 }))).out);
    const others = ALL.filter((o) => o !== "mix" && o !== want).every((o) => p[o] === 0);
    rows.push(`${ch}:${pitch} ${want || "none"} ${want ? p[want].toFixed(3) : p.mix}`);
    check(`use B: channel ${ch} note ${pitch} -> ${want || "nothing"} only (${rows.at(-1)})`, others && (want ? p[want] > 0.005 && p.mix > 0.005 : p.mix === 0));
  }
  // the state plays a song (and has a working pattern): with input, none of it plays (protocol 7b)
  const a = pk((await renderAll(song, req({ input: null, outputs: ALL, toBeat: 12 }))).out);
  const b = pk((await renderAll(song, req({ input: NOTHING, outputs: ALL, toBeat: 12, tailMs: 500 }))).out);
  const g = pk((await renderAll(groove.state, req({ input: NOTHING, outputs: ALL, toBeat: 8, tailMs: 500 }))).out);
  check(`use B: the state's song (use A peak ${a.mix.toFixed(3)}) and pattern do not play: no notes -> every output silent`,
        a.mix > 0.05 && ALL.every((k) => b[k] === 0 && g[k] === 0));
  // velocity: softer notes quieter
  const vel = async (v) => peak((await renderAll({ sectors: {} }, req({ input: { ...NOTHING, notes: [{ beat: 0, lengthBeats: 1, pitch: 60, velocity: v, channel: 0 }] }, outputs: ["t1"], toBeat: 2 }))).out.t1[0]);
  const dvel = async (v) => peak((await renderAll({ sectors: {} }, req({ input: { ...NOTHING, notes: [{ beat: 0, lengthBeats: 1, pitch: 38, velocity: v, channel: 3 }] }, outputs: ["drums"], toBeat: 2 }))).out.drums[0]);
  const [s1, l1, s2, l2] = [await vel(20), await vel(127), await dvel(20), await dvel(127)];
  check(`use B: velocity (track 1 at 20: ${s1.toFixed(3)}, at 127: ${l1.toFixed(3)}; a snare at 20: ${s2.toFixed(3)}, at 127: ${l2.toFixed(3)})`,
        s1 < l1 * 0.8 && s2 < l2 * 0.8 && s1 > 0 && s2 > 0);
}
{ // zero-length notes (protocol 7b): the off after the on, never before; a note that rounds to no frames too
  const n = (beat, lengthBeats, pitch = 60) => ({ beat, lengthBeats, pitch, velocity: 100, channel: 0 });
  const ev = midiEvents({ notes: [n(0, 1), n(1, 0), n(2, 1e-9), n(3, -0)], cc: [], pitchBend: [], preRollBeats: 0 }, 120, 8);
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  const kinds = ev.map((e) => `${e.status >> 4 === 9 ? "on" : "off"}@${e.frame}`);
  const want = [`on@0`, `off@${at(1)}`, `on@${at(1)}`, `off@${at(1) + 32}`, `on@${at(2)}`, `off@${at(2) + 32}`, `on@${at(3)}`, `off@${at(3) + 32}`];
  check(`zero-length notes: each off a block after its on (${kinds.slice(1, 4).join(" ")})`, kinds.join() === want.join());
  const o = (await renderAll({ sectors: {} }, req({ input: { ...NOTHING, notes: [n(1, 0)] }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const held = (await renderAll({ sectors: {} }, req({ input: { ...NOTHING, notes: [n(1, 8)] }, toBeat: 4, outputs: ["t1"] }))).out.t1[0];
  const end = (x) => peak(x.subarray(x.length - 44100));
  check(`zero-length notes: the note sounds (peak ${peak(o).toFixed(3)}) and is let go (the last second ${end(o).toFixed(4)}, held ${end(held).toFixed(4)})`,
        peak(o) > 1e-3 && end(o) < end(held) / 4);
}

// ---- the host's tempo is a runtime value: not the song's G_BPM, not in the state's signature
{
  const d = await Dev.make({ sectors: groove.state.sectors });
  d.run(500);
  const g = () => new Int16Array(d.ex.memory.buffer, d.ex.tutti_song_g(), 1)[0];
  const sig0 = d.ex.tutti_sig(), bpm0 = g();
  d.ex.tutti_tempo(97.3);
  d.run(300);
  d.ex.tutti_tempo(181.25);
  d.run(300);
  check(`host tempo: G_BPM stays the song's (${bpm0} -> ${g()}), the state's signature unchanged`, g() === bpm0 && d.ex.tutti_sig() === sig0);
  d.rq(E.req.trackStep(0, 3, { n: 1, notes: [50, 0, 0, 0], time: 0, flags: 0, vel: 100 }));
  check("an edit through the editor's protocol: the state's signature changes", d.ex.tutti_sig() !== sig0);
}

// ---- the preview's seek: bounded work per call, the time meanwhile added; where it gets to the same as one long seek
{
  const live = async () => { const d = await Dev.make({ sectors: song.sectors }); d.ex.tutti_live_mode(PLAY_MODE.song); d.ex.tutti_tempo(123.45); return d.ex; };
  const a = await live(), b = await live(), B = 1024, Q = 128 / 32, F = 44100 * 150;   // 2.5 minutes in (worklet SEEK_BLOCKS)
  b.tutti_seek(1, F);
  let left = b.tutti_seek_run(B, 0), calls = 1, bounded = left === Math.floor(F / 32) - B;
  const t0 = performance.now();
  while (left) {
    const was = left;
    left = b.tutti_seek_run(B, Q);
    bounded &&= left === Math.max(0, was + Q - B);
    calls++;
  }
  const ms = (performance.now() - t0) / (calls - 1);
  a.tutti_seek(1, F + (calls - 1) * 128);
  a.tutti_seek_run(0xFFFFFFFF, 0);
  const pos = (ex) => `${ex.tutti_clk_beat()}:${ex.tutti_clk_pos()}`;
  check(`seek: 2.5 min in, ${B} blocks a call (${calls} calls, ${ms.toFixed(3)} ms each, a quantum is 2.9 ms)`, bounded && ms < 1.5);
  check(`seek: in steps (the quanta meanwhile added) = in one go (${pos(b)})`, pos(a) === pos(b) && a.tutti_seek_run(B, 0) === 0);
  b.tutti_seek(1, 0);
  const z = b.tutti_seek_run(B, 0);
  b.tutti_seek(0, 0);
  check("seek: to 0 done at once; stopped: nothing to run", z === 0 && b.tutti_seek_run(B, Q) === 0);
}

// ---- 48 kHz: the resampler against a sine
if (!FAST) {
  const f = 1000, n = 44100, l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = r[i] = 0.5 * Math.sin(2 * Math.PI * f * i / 44100);
  const rs = new Resampler(0), ol = new Float64Array(48000), or = new Float64Array(48000);
  rs.push(l, r);
  const k = rs.take(ol, or, 0, 48000);
  let e = 0, c = 0;
  for (let i = 2000; i < k - 2000; i++) { const d = ol[i] - 0.5 * Math.sin(2 * Math.PI * f * i / 48000); e += d * d; c++; }
  const err = Math.sqrt(e / c) / (0.5 / Math.SQRT2);
  check(`48 kHz: a 1 kHz sine resampled, error ${db(err)} dB (under -90), on time (no delay)`, err < 10 ** (-90 / 20));
}

// ---- the state: everything a user makes, packed, unpacked, into a fresh SLOOP, the same; a render of it the same
{
  const buf = packState(song), back = unpackState(buf);
  check(`state: ${buf.byteLength} B, unpacked to the same sectors and meta, the input unchanged`,
        Object.keys(back.sectors).length === Object.keys(song.sectors).length && Object.keys(song.sectors).every((k) => same(song.sectors[k], back.sectors[k])) &&
        back.meta.play === "song" && stateEquals(buf, packState(back)));
  let bad = 0;
  for (const b of [new ArrayBuffer(3), new Uint8Array(20).buffer, buf.slice(0, buf.byteLength - 1)])
    try { unpackState(b); } catch (e) { if (e.code === "state-incompatible") bad++; }
  try { unpackState(buf, 2); } catch (e) { if (e.code === "state-incompatible") bad++; }
  check("state: short, foreign, truncated and other-version states refused (state-incompatible)", bad === 4);
  // the user's whole SLOOP: sections, the song, the working project, settings, a user preset, a user sample slot, an
  // FM6 patch in the bank, a SYN kit edited (not stored), a MIDI channel setting
  const d = await Dev.make({ sectors: song.sectors });
  d.rq(E.req.upStore(3, "MY BASS"));
  const sample = Int16Array.from({ length: 6000 }, (_, i) => Math.round(9000 * Math.sin(i / 7) * Math.exp(-i / 3000)));
  const { hdr, data } = E.buildSlot("TESTSMP", [{ s: sample, root: 60 }]);
  check("a user sample uploaded (SMP_BEGIN / WRITE / END, as the editor's Samples page)", d.rq(E.req.smpBegin(1)).rc === 0 &&
        Array.from({ length: Math.ceil(data.length / 256) }, (_, i) => d.rq(E.req.smpWrite(1, 512 + i * 256, data.subarray(i * 256, i * 256 + 256))).rc).every((x) => x === 0) &&
        d.rq(E.req.smpEnd(1, hdr)).rc === 0);
  const fm6 = d.rq(E.req.fm6Get(0, 0));
  check("an FM6 patch into the bank (FM6_PUT)", !!fm6 && d.rq(E.req.fm6Put(1, 2, fm6.packed || fm6.data || new Uint8Array(128).fill(1))) != null);
  d.rq(E.req.dsynCopy(0, 5));
  d.rq(E.req.trackParam(1, 39, -20));                                   // (track 2's PAN)
  const s = d.state({ play: "B" });
  const fresh = await Dev.make(unpackState(packState(s)));
  const A = await d.backup(), B = await fresh.backup();
  const ids = Object.keys(A).map(Number).sort((x, y) => x - y);
  const diff = ids.filter((id) => A[id] !== B[id]);
  check(`state round trip: every backup object of the editor the same in a fresh SLOOP (${ids.join(" ")}) ${diff.length ? "differ: " + diff : ""}`,
        diff.length === 0 && ids.includes(0) && ids.includes(1) && [2, 3].every((i) => A[i].length > 100) && A[6] && A[6].length > 10 && A[33] && A[33].length > 100);
  const r = req({ outputs: ALL, toBeat: 12, tailMs: 300 });
  const x = await renderAll(s, r), y = await renderAll(fresh.state({ play: "B" }), r);
  check("state round trip: the fresh SLOOP's state renders the same bytes", ALL.every((o) => same(x.out[o][0], y.out[o][0]) && same(x.out[o][1], y.out[o][1])));
}

// ================================================================== the protocol (a fake host)
// a live device as the page has it (tutti.js live): the wasm not headless, its edits checked by tutti_sig
class NodeLive {
  constructor() {
    this.dev = null; this.loads = 0; this.transports = []; this.tempos = []; this.meta = { ...DEFAULT_META };
    this.tempo = new PreviewTempo((bpm) => { this.tempos.push(bpm); this.dev.ex.tutti_tempo(bpm); });   // (as the page's)
  }
  async load(state, context) {
    this.dev = await Dev.make(state);
    this.dev.run(200);
    this.meta = { ...state.meta };
    this.sig = this.dev.ex.tutti_sig();
    this.loads++;
    this.tempo.reset();
    this.context(context);
  }
  edit(fn) {                                          // a user's edit (the editor's requests), then the page's check
    fn(this.dev);
    this.dev.run(50);
    const s = this.dev.ex.tutti_sig();
    if (s !== this.sig) { this.sig = s; this.engine.changed(); }
  }
  async snapshot() {
    const s = this.dev.state(this.meta);
    this.sig = this.dev.ex.tutti_sig();
    return s;
  }
  context(ctx) { this.tempo.context(ctx); }
  transport(t) { this.transports.push(t); }
  close() { this.closed = true; }
}
const HOST = "https://tuttidaw.com";
function harness({ live = null, chunkFrames } = {}) {
  const hello = [];
  const engine = new SloopEngine({
    render: (state, r, sink) => render(mod, state, r, sink, chunkFrames ? { chunkFrames } : {}),
    live, onChanged: (rev) => session.stateChanged(rev),
  });
  if (live) live.engine = engine;
  const session = new PluginSession({ engine, post: (m) => hello.push(m), plugin: { id: "com.weavejam.sloop", version: "t", build: "t" } });
  const h = { session, engine, hello, got: [], waiters: [] };
  h.connect = (o = {}) => {
    const ch = new MessageChannel();
    h.port = ch.port1;
    h.port.onmessage = (e) => {
      h.got.push(e.data);
      for (const w of [...h.waiters]) if (w.pred(e.data)) { h.waiters.splice(h.waiters.indexOf(w), 1); w.res(e.data); }
    };
    h.sid = o.sessionId || "s-" + Math.random().toString(36).slice(2);
    return session.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL, sessionId: h.sid, generation: o.generation ?? 1,
                                             host: { name: "test", version: "0", timeOrigin: 0 } },
                                     origin: o.origin ?? HOST, isParent: o.isParent ?? true, ports: [ch.port2] });
  };
  h.send = (m, transfer) => h.port.postMessage({ sessionId: h.sid, ...m }, transfer || []);
  h.wait = (pred, ms = 60000) => new Promise((res, rej) => {
    const old = h.got.find(pred);
    if (old) { h.got.splice(h.got.indexOf(old), 1); return res(old); }
    const w = { pred, res: (m) => { clearTimeout(t); h.got.splice(h.got.indexOf(m), 1); res(m); } };
    const t = setTimeout(() => { h.waiters.splice(h.waiters.indexOf(w), 1); rej(new Error("timeout waiting")); }, ms);
    h.waiters.push(w);
  });
  h.reply = (id) => h.wait((m) => m.id === id && (m.type.endsWith(":ok") || m.type === "error"));
  h.terminals = (id) => h.got.filter((m) => m.id === id && (m.type.endsWith(":ok") || m.type === "error")).length;
  h.close = () => { try { h.port.close(); } catch {} };
  return h;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = (h, renderId) => {                    // the chunks of a render, granting a credit per chunk taken
  const chunks = [];
  const on = h.port.onmessage;
  h.port.onmessage = (e) => {
    if (e.data.type === "render-chunk" && e.data.renderId === renderId) {
      chunks.push(e.data);
      h.send({ type: "render-credit", renderId, chunks: 1 });
    } else on(e);
  };
  return chunks;
};

// ---- handshake
{
  const h = harness();
  h.session.hello();
  check("hello: {type, protocol} to the parent, nothing else", h.hello.length === 1 && h.hello[0].type === "tutti-plugin:hello" &&
        h.hello[0].protocol === PROTOCOL && Object.keys(h.hello[0]).length === 2);
  const prod = (o) => embedderAllowed(o, CHANNELS.production), prev = (o) => embedderAllowed(o, CHANNELS.preview);
  const never = ["https://pr-12.tuttidaw.com", "http://tuttidaw.com", "https://tuttidaw.com.evil.io", "https://eviltuttidaw.com",
                 "https://a.b.tuttidaw.com", "https://www.tuttidaw.com:8443", "https://TUTTIDAW.com", "https://localhost:3000",
                 "http://127.0.0.1:5173", "http://localhost.evil.io", "http://localhost:5173/", "null", "", undefined];
  check("embedders, production: exactly https://tuttidaw.com and https://www.tuttidaw.com (the default)",
        ["https://tuttidaw.com", "https://www.tuttidaw.com"].every(prod) && !["http://localhost:5173", "http://localhost", ...never].some(prod) &&
        embedderAllowed("https://www.tuttidaw.com") && !embedderAllowed("http://localhost:5173"));
  check("embedders, preview: those and http://localhost:<any port>; not others",
        ["https://tuttidaw.com", "https://www.tuttidaw.com", "http://localhost:5173", "http://localhost"].every(prev) && !never.some(prev));
  check("connect from a wrong origin ignored", h.connect({ origin: "https://evil.example" }) === 0);
  check("connect from another window (not the parent) ignored", h.connect({ isParent: false }) === 0);
  check("connect from the parent at tuttidaw.com accepted", h.connect() === 1);
  const first = h.sid;
  const h2port = h.port;
  check("a second connect ignored while the session lives", h.connect({ sessionId: "other" }) === 0);
  h.port = h2port; h.sid = first;
  h.send({ type: "get-state", id: "g0" });
  const g0 = await h.reply("g0");
  check("get-state before init: error bad-request", g0.type === "error" && g0.code === "bad-request" && g0.fatal === false);
  h.port.postMessage({ type: "init", sessionId: "wrong", id: "x", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(50);
  check("a message of another session dropped (no reply)", !h.got.some((m) => m.id === "x"));
  h.send({ type: "init", id: "i1", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  const i1 = await h.reply("i1");
  check("init (null state, mode render, no gesture, no audio): init:ok {plugin, stateRevision}",
        i1.type === "init:ok" && i1.plugin.id === "com.weavejam.sloop" && i1.stateRevision === 1 && i1.sessionId === first);
  h.send({ type: "init", id: "i2", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  check("init twice: bad-request", (await h.reply("i2")).code === "bad-request");
  h.send({ type: "bogus" });
  h.send({ type: "render", id: "rb" });
  const rb = await h.reply("rb");
  h.port.postMessage("not an object");
  h.send({ type: "render" });
  const noid = await h.wait((m) => m.type === "error" && m.id === undefined);
  check("unknown types and invalid messages: dropped or bad-request, the session goes on", rb.code === "bad-request" && noid.code === "bad-request");
  h.send({ type: "render", id: "big", ...req({ renderId: "big", toBeat: 2000, context: ctxOf(60) }) });
  check("a render over 600 s: too-large", (await h.reply("big")).code === "too-large");
  h.send({ type: "render", id: "sr", ...req({ renderId: "sr", sampleRate: 96000 }) });
  check("a render at 96 kHz: unsupported", (await h.reply("sr")).code === "unsupported");
  h.send({ type: "render", id: "tc", ...req({ renderId: "tc", context: ctxOf(120, [{ beat: 4, bpm: 90, ramp: "step" }]) }) });
  check("a tempo change in the range (tempoMap constant): unsupported", (await h.reply("tc")).code === "unsupported");
  h.send({ type: "render", id: "rv", ...req({ renderId: "rv", stateRevision: 7 }) });
  check("a render of an unknown state revision: state-incompatible", (await h.reply("rv")).code === "state-incompatible");
  h.send({ type: "close" });
  await sleep(20);
  check("close: the session ends; a new connect (a reload) is a new session", h.session.state === "closed" && h.connect({ generation: 2 }) === 1);
  h.send({ type: "init", id: "i3", sampleRate: 44100, context: ctxOf(120), state: packState(song), stateVersion: STATE_VERSION, mode: "render" });
  check("init with a saved state in the new session: init:ok", (await h.reply("i3")).type === "init:ok");
  const h3 = harness();
  h3.connect();
  h3.send({ type: "init", id: "i5", sampleRate: 44100, context: ctxOf(120), state: new ArrayBuffer(16), stateVersion: 1, mode: "render" });
  const i5 = await h3.reply("i5");
  const h4 = harness();
  h4.connect();
  h4.send({ type: "init", id: "i6", sampleRate: 44100, context: ctxOf(120), state: packState(song), stateVersion: 9, mode: "render" });
  const i6 = await h4.reply("i6");
  check("init with a foreign state or an unread version: state-incompatible", i5.code === "state-incompatible" && i6.code === "state-incompatible");
  h.close(); h3.close(); h4.close();
}

// ---- renders through the session: chunks, lengths, credits, cancel, busy, determinism
{
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(123.45), state: packState(song), stateVersion: 1, mode: "render" });
  const rev = (await h.reply("i")).stateRevision;
  h.send({ type: "render", id: "c1", ...req({ renderId: "c1", stateRevision: rev, context: ctxOf(123.45), toBeat: 40, outputs: ALL }) });
  await sleep(2500);
  const inFlight = h.got.filter((m) => m.type === "render-chunk" && m.renderId === "c1").length;
  check(`credits: ${inFlight} chunks out with the ${INITIAL_CREDITS} initial credits, then it waits`, inFlight === INITIAL_CREDITS && h.terminals("c1") === 0);
  h.send({ type: "render", id: "c2", ...req({ renderId: "c2", stateRevision: rev }) });
  const busy = await h.reply("c2");
  check("a second render while one runs: busy", busy.code === "busy" && busy.renderId === "c2");
  h.send({ type: "render-credit", renderId: "c1", chunks: 3 });
  await sleep(1500);
  const after = h.got.filter((m) => m.type === "render-chunk" && m.renderId === "c1").length;
  check(`credits: 3 more granted, ${after - inFlight} more chunks`, after === inFlight + 3);
  h.send({ type: "cancel", renderId: "c1" });
  const term = await h.reply("c1");
  await sleep(300);
  check("cancel mid-render: exactly one terminal, error cancelled", term.code === "cancelled" && h.terminals("c1") === 0);
  const run = async (id, extra = {}) => {
    const chunks = collect(h, id);
    h.send({ type: "render", id, ...req({ renderId: id, stateRevision: rev, context: ctxOf(123.45), fromBeat: 2, toBeat: 18, tailMs: 750, outputs: ALL, ...extra }) });
    const ok = await h.reply(id);
    return { ok, chunks };
  };
  const a = await run("w1"), b = await run("w2");
  const want = Math.round(18 * 60 / 123.45 * 44100) - Math.round(2 * 60 / 123.45 * 44100) + Math.ceil(0.75 * 44100);
  const len = (cs, o) => cs.filter((c) => c.output === o).reduce((s, c) => s + c.channels[0].length, 0);
  check(`render via the session: render:ok, each output ${want} frames, chunks <= 1 s, offsets in order`,
        a.ok.type === "render:ok" && ALL.every((o) => len(a.chunks, o) === want) && a.chunks.every((c) => c.channels[0].length <= 44100 && c.channels.length === 2) &&
        ALL.every((o) => a.chunks.filter((c) => c.output === o).every((c, i, cs) => c.frameOffset === (i ? cs[i - 1].frameOffset + cs[i - 1].channels[0].length : 0))));
  check(`render:ok is {type, id, renderId, frames: ${want}, outputs, build} after the last chunk`,
        Object.keys(a.ok).sort().join() === "build,frames,id,outputs,renderId,sessionId,type" && a.ok.frames === want &&
        a.ok.outputs.join() === ALL.join() && a.ok.build === "t" && a.ok.renderId === "w1");
  check("render via the session twice: the same bytes", a.chunks.length === b.chunks.length &&
        a.chunks.every((c, i) => c.output === b.chunks[i].output && same(c.channels[0], b.chunks[i].channels[0]) && same(c.channels[1], b.chunks[i].channels[1])));
  const pw = h.got.filter((m) => m.type === "render-progress" && m.renderId === "w2");
  check(`progress: render-progress messages, fraction 0..1, the last 1 (${pw.length} for w2)`,
        pw.length > 0 && pw.at(-1).fraction === 1 && pw.every((m, i) => !i || m.fraction >= pw[i - 1].fraction));
  h.close();
}

// ---- sessions apart: what a request of an ended session sends goes nowhere, not into the next session
{
  const ctl = { initDelay: 0, renders: [] };
  const engine = {
    init: async () => { await sleep(ctl.initDelay); return { stateRevision: 1 }; },
    context() {}, transport() {}, close() {},
    getState: async () => { await sleep(ctl.initDelay); return { state: new ArrayBuffer(4), stateVersion: 1, stateRevision: 1 }; },
    render: (r, sink) => new Promise((res, rej) => ctl.renders.push({ r, sink, res, rej })),
  };
  const session = new PluginSession({ engine, post: () => {}, plugin: { id: "x", version: "t", build: "b1" } });
  const conn = (sid) => {
    const ch = new MessageChannel(), got = [];
    ch.port1.onmessage = (e) => got.push(e.data);
    const ok = session.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL, sessionId: sid, generation: 1, host: {} },
                                         origin: HOST, isParent: true, ports: [ch.port2] });
    return { ok, got, send: (m) => ch.port1.postMessage({ sessionId: sid, ...m }), close: () => ch.port1.close() };
  };
  ctl.initDelay = 200;
  const a = conn("A");
  a.send({ type: "init", id: "ia", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(30);
  a.send({ type: "close" });
  await sleep(30);
  ctl.initDelay = 0;
  const b = conn("B");
  await sleep(300);
  b.send({ type: "get-state", id: "gb" });
  await sleep(50);
  const gb = b.got.find((m) => m.id === "gb");
  check("a late init of an ended session: the new session not inited (bad-request), no init:ok anywhere",
        b.ok === 1 && session.inited === false && session.state === "initializing" && gb && gb.code === "bad-request" &&
        !a.got.concat(b.got).some((m) => m.type === "init:ok"));
  b.send({ type: "init", id: "ib", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(50);
  b.send({ type: "render", id: "rb", ...req({ renderId: "rb" }) });
  await sleep(50);
  ctl.initDelay = 150;
  b.send({ type: "get-state", id: "gs" });
  await sleep(20);
  b.send({ type: "close" });
  await sleep(30);
  ctl.initDelay = 0;
  const c = conn("C");
  c.send({ type: "init", id: "ic", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await sleep(50);
  c.send({ type: "render", id: "rc", ...req({ renderId: "rc" }) });
  await sleep(50);
  const old = ctl.renders[0];
  let cancelled = false;
  try { await old.sink.chunk("mix", 0, [new Float32Array(4), new Float32Array(4)]); } catch (e) { cancelled = e.code === "cancelled"; }
  old.sink.progress(0.5);
  old.res({ frames: 4, outputs: ["mix"] });
  await sleep(200);
  const cur = ctl.renders[1];
  await cur.sink.chunk("mix", 0, [new Float32Array(4), new Float32Array(4)]);
  cur.res({ frames: 4, outputs: ["mix"] });
  await sleep(50);
  const ofB = c.got.filter((m) => m.renderId === "rb" || m.id === "rb" || m.id === "gs");
  const okC = c.got.find((m) => m.id === "rc");
  check("a render of an ended session: its sink cancelled, nothing of it (or its get-state) in the next session",
        cancelled && ofB.length === 0 && c.got.every((m) => m.sessionId === "C") && !b.got.some((m) => m.id === "gs" || m.id === "rb"));
  check("the next session's render runs alongside (not busy), its render:ok has its build",
        ctl.renders.length === 2 && okC && okC.type === "render:ok" && okC.build === "b1" && okC.frames === 4 && session.render === null);
  a.close(); b.close(); c.close();
  session.close();
  const s2 = new PluginSession({ engine, post: () => {}, plugin: { id: "x", version: "t", build: "b1" } });
  s2.stopAccepting();
  const ch = new MessageChannel();
  check("a connect after going standalone: refused", s2.onWindowMessage({ data: { type: "tutti-plugin:connect", protocol: PROTOCOL,
        sessionId: "late", generation: 1, host: {} }, origin: HOST, isParent: true, ports: [ch.port2] }) === 0 && s2.port === null);
  ch.port1.close();
}

// ---- the site (site.mjs): per channel, the embedders in build-info.js and _headers alike, the manifest, the CSP
{
  const site = (channel, env = {}) => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), `sloop-site-${channel}-`));
    const r = spawnSync(process.execPath, [path.join(ROOT, "web/plugin/site.mjs"), path.resolve(wasmPath), out, "SLOOP 2.8"],
                        { cwd: ROOT, env: { ...process.env, PLUGIN_ALLOW_DIRTY: "", ...env, PLUGIN_CHANNEL: channel }, encoding: "utf8" });
    return { out, ...r };
  };
  const dirty = execSync("git status --porcelain", { cwd: ROOT }).toString().trim() !== "";
  const checkSite = async (channel, s) => {
    const rd = (f) => fs.readFileSync(path.join(s.out, f), "utf8");
    const headers = rd("_headers"), m = JSON.parse(rd("tutti-plugin.json"));
    const info = await import(pathToFileURL(path.join(s.out, "plugin/build-info.js")).href);
    const anc = [...headers.matchAll(/frame-ancestors ([^;\n]*)/g)].map((x) => x[1]);
    const page = rd("plugin/index.html"), inline = /<script>([\s\S]*?)<\/script>/.exec(page)[1];
    const hash = crypto.createHash("sha256").update(inline, "utf8").digest("base64");
    const csp = /\/plugin\/\*\n  Content-Security-Policy: ([^\n]*)/.exec(headers)[1];
    check(`site ${channel}: build-info EMBEDDERS and every frame-ancestors = ${CHANNELS[channel].join(" ")}`,
          JSON.stringify(info.EMBEDDERS) === JSON.stringify(CHANNELS[channel]) && anc.length === 2 &&
          anc.every((a) => a === CHANNELS[channel].join(" ")) && info.BUILD.channel === channel);
    check(`site ${channel}: manifest id, name, vendor, licence, notice, outputs, seek false, midiChannels 0..3, the pinned source`,
          m.id === "com.weavejam.sloop" && m.name === "SLOOP" && m.vendor === "weavejam (SLOOP firmware by isod89)" &&
          m.license === "GPL-3.0-only" && m.notice === "Not affiliated with or endorsed by M-VAVE or Hügelton Instruments." &&
          m.upstream === "https://github.com/isod89/sloop-fm1" && m.capabilities.outputs.map((o) => o.id).join() === ALL.join() &&
          m.capabilities.seek === false && m.capabilities.midiChannels.map((c) => c.channel).join() === "0,1,2,3" &&
          m.capabilities.ownSequencer && m.capabilities.acceptsMidi && m.capabilities.tempoMap === "constant" &&
          /^https:\/\/github\.com\/weavejam\/sloop-fm1\/tree\/[0-9a-f]{40}$/.test(m.source) && m.source === info.BUILD.source &&
          /^0\.1\.0\+sloop\.2\.8/.test(m.version));
    check(`site ${channel}: the page: the editor with tutti-host.js before its script; its CSP (the editor's script's hash)`,
          page.indexOf('<script src="tutti-host.js"></script>') < page.indexOf("<script>") && page.includes('<script type="module" src="tutti.js">') &&
          !page.includes("serviceWorker.register") && !page.includes("../installer/") &&
          csp.startsWith(`default-src 'none'; script-src 'self' 'sha256-${hash}' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; `) &&
          ["style-src 'self' 'unsafe-inline'", "frame-src 'none'", "form-action 'none'"].every((d) => csp.includes(d)) &&
          /\/tutti-plugin\.json\n  Access-Control-Allow-Origin: \*\n  Cache-Control: no-cache/.test(headers) &&
          /\/\*\.wasm\n  Content-Type: application\/wasm/.test(headers));
    fs.rmSync(s.out, { recursive: true, force: true });
  };
  const pv = site("preview", { PLUGIN_ALLOW_DIRTY: "1" });
  check(`site preview: built (${dirty ? "a dirty tree, allowed for a preview: marked" : "a clean tree"})`, pv.status === 0 &&
        (!dirty || fs.readFileSync(path.join(pv.out, "tutti-plugin.json"), "utf8").includes(".dirty")));
  if (pv.status === 0) await checkSite("preview", pv); else console.log(pv.stderr);
  const pr = site("production");
  if (dirty) {
    const forced = site("production", { PLUGIN_ALLOW_DIRTY: "1" });
    check("site production on a dirty tree: refused (also with PLUGIN_ALLOW_DIRTY=1)", pr.status === 1 && /changes not in/.test(pr.stderr) && forced.status === 1);
    console.log("plugin:   (the production site's checks need a clean tree: commit, then run again)");
    for (const x of [pr, forced]) fs.rmSync(x.out, { recursive: true, force: true });
  } else {
    check("site production: built", pr.status === 0);
    await checkSite("production", pr);
  }
  const bad = site("staging", { PLUGIN_ALLOW_DIRTY: "1" });
  check("site: an unknown PLUGIN_CHANNEL refused", bad.status === 1 && /PLUGIN_CHANNEL/.test(bad.stderr));
  fs.rmSync(bad.out, { recursive: true, force: true });
}

// ---- edit mode: the live device, edits -> revisions, state-changed debounced, get-state, the round trip
{
  const live = new NodeLive(), h = harness({ live });
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  const i = await h.reply("i");
  check("edit mode: init:ok, the live device loaded", i.type === "init:ok" && live.loads === 1);
  h.send({ type: "context", context: ctxOf(97.5) });
  h.send({ type: "context", context: { timeMap: { tempoPoints: [] } } });
  h.send({ type: "get-state", id: "g0" });
  await h.reply("g0");
  check(`context after init: to the live preview, its tempo ${live.tempos.join(" -> ")}; a malformed one changes nothing`,
        live.tempos.join() === "120,97.5" && live.tempo.bpm === 97.5 && !h.got.some((m) => m.type === "error"));
  h.send({ type: "get-state", id: "g1" });
  const g1 = await h.reply("g1");
  live.edit((d) => d.steps(0, [[0, [48]], [4, [51]], [8, [55]]]));
  live.edit((d) => d.drums([[0, [0]], [8, [2]]]));
  live.edit((d) => d.rq(E.req.trackParam(0, 39, 30)));
  await sleep(100);
  const early = h.got.filter((m) => m.type === "state-changed").length;
  const sc = await h.wait((m) => m.type === "state-changed", 5000);
  await sleep(700);
  check(`edits: one state-changed after >= 500 ms (debounced), revision ${g1.stateRevision} -> ${sc.stateRevision}`,
        early === 0 && sc.stateRevision === g1.stateRevision + 1 && h.got.filter((m) => m.type === "state-changed").length === 0);
  h.send({ type: "get-state", id: "g2" });
  const g2 = await h.reply("g2");
  h.send({ type: "get-state", id: "g3" });
  const g3 = await h.reply("g3");
  check("get-state after edits: the new revision; again without edits: the same revision, the same bytes",
        g2.type === "get-state:ok" && g2.stateRevision === sc.stateRevision && g2.stateVersion === STATE_VERSION &&
        g3.stateRevision === g2.stateRevision && stateEquals(g2.state, g3.state) && !stateEquals(g1.state, g2.state));
  const chunks = collect(h, "e1");
  h.send({ type: "render", id: "e1", ...req({ renderId: "e1", stateRevision: g2.stateRevision, outputs: ["mix", "t1", "drums"], toBeat: 8 }) });
  await h.reply("e1");
  const h2 = harness();
  h2.connect();
  h2.send({ type: "init", id: "j", sampleRate: 44100, context: ctxOf(120), state: g2.state, stateVersion: g2.stateVersion, mode: "render" });
  const j = await h2.reply("j");
  const chunks2 = collect(h2, "e2");
  h2.send({ type: "render", id: "e2", ...req({ renderId: "e2", stateRevision: j.stateRevision, outputs: ["mix", "t1", "drums"], toBeat: 8 }) });
  await h2.reply("e2");
  check(`state round trip: get-state -> init in a new session -> the same render (${chunks.length} chunks, peak ${peak(chunks[0].channels[0]).toFixed(3)})`,
        chunks.length === chunks2.length && peak(chunks[0].channels[0]) > 0.05 &&
        chunks.every((c, k) => c.output === chunks2[k].output && same(c.channels[0], chunks2[k].channels[0]) && same(c.channels[1], chunks2[k].channels[1])));
  live.edit((d) => d.rq(E.req.trackParam(0, 39, -30)));
  h.send({ type: "render", id: "e3", ...req({ renderId: "e3", stateRevision: g1.stateRevision }) });
  const e3 = await h.reply("e3");
  check("an older revision (kept) still renders", e3.type === "render:ok");
  h.send({ type: "transport", generation: 3, playing: true, beat: 4, atEpochMs: 1000, loop: null });
  h.send({ type: "transport", generation: 3, playing: "yes", beat: 4, atEpochMs: 1000, loop: null });
  await sleep(50);
  check("transport: to the live device (preview); a malformed one dropped", live.transports.length === 1 && live.transports[0].beat === 4);
  h.session.commit({ fromBeat: 0, toBeat: 12, outputs: ["mix"] });
  const cm = await h.wait((m) => m.type === "commit");
  check("commit (the Render to tuttidaw button): {type: commit, fromBeat, toBeat, outputs}", cm.outputs[0] === "mix" && cm.toBeat === 12 && cm.sessionId === h.sid);
  h.send({ type: "close" });
  await sleep(20);
  check("close: the live device closed", live.closed === true);
  h.close(); h2.close();
}

// ---- the engine across sessions: a snapshot asked for in a session that ended comes late
{
  const snaps = [], renders = [];
  const live = { load: async () => {}, context() {}, transport() {}, close() {},
                 snapshot: () => new Promise((res) => snaps.push(res)) };
  const engine = new SloopEngine({ render: (st) => { renders.push(st); return { frames: 1, outputs: ["mix"] }; }, live });
  const st = (v) => ({ sectors: { 0xE5000: new Uint8Array(4096).fill(v) }, meta: { play: "auto" } });
  await engine.init({ context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  engine.changed();
  let ended = false;
  const r1 = engine.render(req({ stateRevision: 2 }), { cancelled: () => ended }).then(() => "rendered", (e) => e.code);
  await sleep(0);
  ended = true;
  snaps.shift()(st(1));
  check(`a render whose session ended while its state was made: ${await r1}, nothing rendered`, (await r1) === "cancelled" && renders.length === 0);
  engine.changed();
  const g = engine.getState().then(() => "ok", (e) => e.code);
  await sleep(0);
  const stB = packState(st(2));
  await engine.init({ context: ctxOf(120), state: stB, stateVersion: STATE_VERSION, mode: "edit" });
  snaps.shift()(st(3));
  const gs = await g, now = await engine.getState();
  check(`a late snapshot of an ended session: dropped (${gs}), the new session's revision 1 its init state`,
        gs === "session-ended" && now.stateRevision === 1 && stateEquals(now.state, stB) && engine.states.size === 1 && snaps.length === 0);
  engine.changed();
  const g2 = engine.getState();
  await sleep(0);
  engine.changed();
  snaps.shift()(st(3));
  const s2 = await g2;
  check(`a change while a snapshot is made: kept as revision ${s2.stateRevision}, now ${engine.revision}`,
        s2.stateRevision === 2 && engine.revision === 3 && engine.dirty && stateEquals(engine.states.get(2).buf, packState(st(3))));
}

// ================================================================== Felucca's review fixes (#4), here too
// ---- a revision is one state: its snapshot made once, whoever asks for it while it is made
{
  const snaps = [], rendered = [];
  const live = { load: async () => {}, context() {}, transport() {}, close() {},
                 snapshot: () => new Promise((res) => snaps.push(res)) };
  const engine = new SloopEngine({ render: (st) => { rendered.push(st); return { frames: 1, outputs: ["mix"] }; }, live });
  const st = (v) => ({ sectors: { 0xE5000: new Uint8Array(4096).fill(v) }, meta: { play: "auto" } });
  await engine.init({ context: ctxOf(120), state: null, stateVersion: null, mode: "edit" });
  engine.changed();
  const g1 = engine.getState();
  await sleep(0);
  const g2 = engine.getState();                       // (a second get-state while the first is made)
  const r = engine.render(req({ stateRevision: 2 }), { cancelled: () => false });
  await sleep(0);
  const asked = snaps.length;
  snaps.shift()(st(4));                                // the device as it was asked
  while (snaps.length) snaps.shift()(st(5));           // (an edit meanwhile, its change not in yet: another state)
  const [s1, s2] = await Promise.all([g1, g2]);
  await r;
  check(`one snapshot per revision: ${asked} for get-state, get-state, render of revision 2; one state, the same bytes`,
        asked === 1 && s1.stateRevision === 2 && s2.stateRevision === 2 && stateEquals(s1.state, s2.state) &&
        stateEquals(s1.state, packState(st(4))) && rendered.length === 1 && rendered[0] === engine.states.get(2).state);
  engine.changed();
  const g3 = engine.getState();
  await sleep(0);
  engine.changed();
  const r3 = engine.render(req({ stateRevision: 3 }), { cancelled: () => false }).then(() => "rendered", (e) => e.code);
  await sleep(0);
  const asked3 = snaps.length;
  while (snaps.length) snaps.shift()(st(5));
  const s3 = await g3;
  check(`a render of a revision still being made (now ${engine.revision}): ${await r3}, its one snapshot`,
        asked3 === 1 && (await r3) === "rendered" && s3.stateRevision === 3 && rendered.at(-1) === engine.states.get(3).state);
}

// ---- use B: the sustain pedal down over toBeat (its pedal-up past it) lets go at toBeat: nothing held into the tail
{
  const n = (beat, lengthBeats) => ({ beat, lengthBeats, pitch: 60, velocity: 100, channel: 0 });
  const ped = (beat, value) => ({ beat, channel: 0, cc: 64, value });
  const inp = (cc) => ({ notes: [n(1, 10)], cc, pitchBend: [], preRollBeats: 0 });
  const end = Math.round(4 * 0.5 * 44100);
  const k = midiEvents(inp([ped(0.5, 127), ped(6, 0)]), 120, 4).map((e) => `${e.status.toString(16)}:${e.d1}:${e.d2}@${e.frame}`);
  check(`sustain: the pedal up at toBeat, before the note's off there (${k.slice(-2).join(" ")})`,
        k.slice(-2).join() === [`b0:64:0@${end}`, `80:60:0@${end}`].join());
  const one = async (cc) => (await renderAll({ sectors: {} }, req({ input: inp(cc), toBeat: 4, tailMs: 3000, outputs: ["t1"] }))).out.t1[0];
  const free = await one([]), held = await one([ped(0.5, 127), ped(6, 0)]);
  const tail = (x) => rms(x.subarray(end + 44100));
  check(`sustain: the tail past toBeat as without the pedal (rms ${tail(held).toExponential(2)}, no pedal ${tail(free).toExponential(2)})`,
        rms(free.subarray(end - 22050, end)) > 1e-3 && tail(held) <= tail(free) * 1.05 + 1e-6);
}

// ---- use B with a saved KBD HOLD (track 1) and ARP HOLD (track 2, the arp UP): the host's note-offs let the notes go
// all the same (a runtime override, the state keeps HOLD on), and at toBeat nothing is held: past a note's end and its
// release only a decaying tail, no new note (the arp stops); renders the same as without HOLD
{
  const P_AMODE = 17, P_AHOLD = 23;                    // (core.h)
  const make = async (hold) => {
    const d = await Dev.make();
    d.clearAll();
    d.rq(E.req.trackParam(1, P_AMODE, 1));             // (track 2: ARP UP)
    if (hold) { d.rq(E.req.trackParam(0, P_AHOLD, 1)); d.rq(E.req.trackParam(1, P_AHOLD, 1)); }
    const st = d.state();
    return { st, hold: [0, 1].map((k) => d.rq(E.req.trackParam(k, P_AHOLD)).value) };
  };
  const held = await make(true), free = await make(false);
  const n = (beat, lengthBeats, pitch, channel) => ({ beat, lengthBeats, pitch, velocity: 110, channel });
  const inp = { notes: [n(0, 1, 60, 0), n(0, 1, 60, 1), n(0, 1, 64, 1), n(0, 1, 67, 1), n(2.5, 4, 62, 0), n(2.5, 4, 72, 1)],
                cc: [], pitchBend: [], preRollBeats: 0 };
  const r = req({ input: inp, toBeat: 4, tailMs: 4000, outputs: ["mix", "t1", "t2"] });
  const a = (await renderAll(held.st, r)).out, b = (await renderAll(free.st, r)).out;
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  // from a note's end on, in 250 ms windows: never much louder than the window before (no new note: the delay's echoes
  // may wobble), and down by 30 dB within 3 s (the release and the FX tails ring out, then nothing)
  const W = 11025, prof = (x, from) => Array.from({ length: 12 }, (_, i) => rms(x.subarray(from + i * W, from + (i + 1) * W)));
  const decays = (x, from) => { const v = prof(x, from); return v.every((y, i) => !i || y <= v[i - 1] * 1.5 + 1e-6) && v[11] < v[0] / 30; };
  const t1 = decays(a.t1[0], at(4)), t2 = decays(a.t2[0], at(4));
  const gap = rms(a.t2[0].subarray(at(2), at(2.5))), first = rms(a.t2[0].subarray(at(0), at(1)));
  const end = rms(a.mix[0].subarray(a.mix[0].length - 22050)), body = rms(a.mix[0].subarray(0, at(1)));
  if (process.env.VERBOSE) console.log(prof(a.t1[0], at(4)).map((x) => x.toExponential(1)).join(" "), "|", prof(a.t2[0], at(4)).map((x) => x.toExponential(1)).join(" "), gap, first);
  check(`use B + KBD HOLD / ARP HOLD saved (${held.hold.join(",")}): after each note's end only a decaying tail, the arp stopped (t1 ${t1}, t2 ${t2})`,
        held.hold.join() === "1,1" && t1 && t2 && gap < first / 10 && body > 1e-3 && end < body / 100);
  check("use B + HOLD: the same render as without HOLD (the host's note lifetimes), the state's HOLD unchanged",
        ["mix", "t1", "t2"].every((o) => same(a[o][0], b[o][0]) && same(a[o][1], b[o][1])) && free.hold.join() === "0,0");
}

// ---- the preview plays what a render plays: "B" (a section) previews section B, not the working pattern; the working
// pattern put aside meanwhile and back at the stop; no new revision (the state's signature the same throughout)
{
  const d = await Dev.make({ sectors: song.sectors }), ex = d.ex;
  d.run(300);
  const sig0 = ex.tutti_sig() >>> 0, pat0 = d.state().sectors;
  ex.dev_master(1023);
  ex.tutti_tempo(120);
  ex.tutti_live_mode(PLAY_MODE.B);
  ex.tutti_seek(1, 0);
  while (ex.tutti_seek_run(1024, 0));
  const n = 1380 * 128, live = new Float32Array(n);
  for (let i = 0; i < n; i += 128) { ex.dev_render(128); live.set(new Float32Array(ex.memory.buffer, ex.dev_out_l(), 128), i); }
  const sigPlaying = ex.tutti_sig() >>> 0;
  ex.tutti_seek(0, 0);
  d.run(300);
  const sig1 = ex.tutti_sig() >>> 0, pat1 = d.state().sectors;
  const p = (play) => ({ sectors: song.sectors, meta: { play } });
  const rB = (await renderAll(p("B"), req({ toBeat: 8 }))).out.mix[0], rP = (await renderAll(p("pattern"), req({ toBeat: 8 }))).out.mix[0];
  // the envelope (rms per 10 ms), the live one a block later (the render drops the limiter's look-ahead)
  const env = (x, off = 0) => Array.from({ length: Math.floor((n - 882) / 441) }, (_, i) => rms(x.subarray(off + i * 441, off + i * 441 + 441)));
  const corr = (u, v) => { const m = (w) => w.reduce((s, x) => s + x, 0) / w.length, mu = m(u), mv = m(v);
    let s = 0, su = 0, sv = 0; for (let i = 0; i < u.length; i++) { s += (u[i] - mu) * (v[i] - mv); su += (u[i] - mu) ** 2; sv += (v[i] - mv) ** 2; } return s / Math.sqrt(su * sv); };
  const eL = env(live, 32), cB = corr(eL, env(rB)), cP = corr(eL, env(rP));
  const exact = same(live.subarray(32, n), rB.subarray(0, n - 32));
  check(`preview of "B": section B as the render plays it (${exact ? "bit for bit" : `envelope r ${cB.toFixed(3)}`}; the working pattern's r ${cP.toFixed(3)})`,
        peak(live) > 0.05 && (exact || (cB > 0.95 && cB > cP + 0.2)));
  check("preview of a section: the state's signature unchanged while it plays and after; the working pattern back at the stop",
        sigPlaying === sig0 && sig1 === sig0 && Object.keys(pat0).every((k) => same(pat0[k], pat1[k])));
}

// ---- MIDI sync inert: a song saved with GLO > SYNC set to an external clock plays at the host's tempo, hosted and in a
// render (no clock reaches the page's SLOOP: dev_midi takes channel messages only; a render sets SYNC off), and the
// saved SYNC stays the user's
{
  const G_SYNC = 13;                                   // (core.h)
  const d = await Dev.make({ sectors: groove.state.sectors });
  d.rq(E.req.set(1, G_SYNC, 1));
  d.run(100);
  const ext = d.state();
  const ex = (await Dev.make(ext)).ex;
  const sync = () => new Int16Array(ex.memory.buffer, ex.tutti_song_g(), 64)[G_SYNC];
  ex.tutti_tempo(120);
  ex.dev_midi(0xF8, 0, 0);                             // (a clock pulse from the page: refused)
  ex.tutti_seek(1, 0);
  ex.tutti_seek_run(1024, 0);
  for (let k = 0; k < 250 * 44.1; k += 128) ex.dev_render(128);
  const b0 = ex.tutti_clk_beat() * 2646000 + ex.tutti_clk_pos();
  for (let k = 0; k < 500 * 44.1; k += 128) ex.dev_render(128);
  const b1 = ex.tutti_clk_beat() * 2646000 + ex.tutti_clk_pos();
  check(`hosted preview of a song saved with SYNC on: the internal clock at the host's tempo (a beat in 0.5 s: ${((b1 - b0) / 2646000).toFixed(3)})`,
        Math.abs((b1 - b0) / 2646000 - 1) < 0.01 && sync() === 1);
  const a = (await renderAll(ext, req({ toBeat: 8 }))).out.mix[0];
  check(`a render of a SYNC song: it plays at the host's tempo (peak ${peak(a).toFixed(3)}); the state keeps SYNC on`,
        peak(a) > 0.05 && same(a, (await renderAll(groove.state, req({ toBeat: 8 }))).out.mix[0]));
}

// ---- use B: a negative length (protocol 7b: <= 0) is a zero-length note: its on, then its off a block after
{
  const at = (beat) => Math.round(beat * 0.5 * 44100);
  let k;
  try {
    k = midiEvents({ notes: [{ beat: 1, lengthBeats: -0.75, pitch: 60, velocity: 100, channel: 0 }], cc: [], pitchBend: [], preRollBeats: 0 }, 120, 8)
      .map((e) => `${e.status >> 4 === 9 ? "on" : "off"}@${e.frame}`).join(" ");
  } catch (err) { k = `${err.code}`; }
  check(`a note of length -0.75: accepted, its on then its off (${k})`, k === `on@${at(1)} off@${at(1) + 32}`);
}

// ---- the range's limits: frames the device can count, the pre-roll from beat 0, the credits a render holds
{
  const code = (o) => { try { planRender(req(o)); return "ok"; } catch (err) { return err.code; } };
  const far = code({ fromBeat: 1e12, toBeat: 1e12 + 4 });
  const pre = code({ fromBeat: 1300, toBeat: 1304 });  // 650 s of pre-roll at 120 BPM
  const near = code({ fromBeat: 1218, toBeat: 1222 }); // 609 s
  check(`frames past 2^32 from beat 0: ${far}; a pre-roll over 610 s: ${pre}; 609 s: ${near}`,
        far === "bad-request" && pre === "too-large" && near === "ok");
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await h.reply("i");
  h.send({ type: "render", id: "pr", ...req({ renderId: "pr", fromBeat: 1300, toBeat: 1304 }) });
  const pr = await h.reply("pr");
  h.send({ type: "render", id: "cr", ...req({ renderId: "cr", toBeat: 800, outputs: ALL }) });
  await sleep(200);
  for (let i = 0; i < 3; i++) h.send({ type: "render-credit", renderId: "cr", chunks: 1e6 });
  await sleep(100);
  const credits = h.session.render ? h.session.render.credits : NaN;
  h.send({ type: "cancel", renderId: "cr" });
  const cr = await h.reply("cr");
  check(`a render with 650 s of pre-roll: ${pr.code}; credits granted 3 x 1e6: ${credits} held (at most 600 s x 8 outputs)`,
        pr.code === "too-large" && credits > 0 && credits <= 4800 && cr.code === "cancelled");
  h.close();
}

// ---- the port's messageerror ends the session: its render cancelled, the port let go, a new connect accepted
{
  const h = harness();
  h.connect();
  h.send({ type: "init", id: "i", sampleRate: 44100, context: ctxOf(120), state: null, stateVersion: null, mode: "render" });
  await h.reply("i");
  h.send({ type: "render", id: "me", ...req({ renderId: "me", toBeat: 400 }) });
  await sleep(300);
  const port = h.session.port, r = h.session.render;
  const has = typeof port.onmessageerror === "function";
  if (has) port.onmessageerror(new Event("messageerror"));
  await sleep(100);
  check("port messageerror: the session closed, its render cancelled, the port's handlers off, a new connect accepted",
        has && h.session.state === "closed" && !!r && r.cancel === true && h.session.render === null && h.session.port === null &&
        !port.onmessage && !port.onmessageerror && h.connect({ generation: 2 }) === 1);
  h.close();
}

console.log(fails ? `plugin: ${fails} FAILED` : "plugin: all ok");
process.exit(fails ? 1 : 0);
