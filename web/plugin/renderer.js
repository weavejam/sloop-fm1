// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The offline renderer (tutti-plugin/0 `render`), after Felucca's (weavejam/Felucca web/plugin/renderer.js): a fresh
// instance of sloop.wasm (web/plugin/sloop_plugin.c) per render, booted with the state's flash, the host's tempo, the
// transport started at its frame 0 = beat 0 (use A: SLOOP's own sequencer, playing the song (the arranger), the
// working pattern or a section, as the state's `play` says; use B: the request's MIDI instead, the sequencer never
// started), rendered from there (every render from the song's start, so what sounds at fromBeat is what playing from
// the top gives: held notes, delay and reverb tails, LFOs, the song's sections), the frames before fromBeat dropped.
// Runs where it is called: a Worker (render-worker.js) or Node (tests).
//   mix               the master output, as SLOOP's (the buses, DUST, the master filter, the limiter, the knee),
//                     MASTER at its top
//   t1 t2 t3 drums    a render unit's stem: its dry mix and its own share of the buses (README "Stems")
// 44.1 kHz is the firmware's rate; 48 kHz through resample.js.
import { Resampler } from "./resample.js";
import { restoreSectors, cleanMeta } from "./state.js";

export const NATIVE_RATE = 44100;
export const SAMPLE_RATES = [44100, 48000];
export const OUTPUTS = [
  { id: "mix", name: "Mix", channels: 2 },
  { id: "t1", name: "Track 1", channels: 2 },
  { id: "t2", name: "Track 2", channels: 2 },
  { id: "t3", name: "Track 3", channels: 2 },
  { id: "drums", name: "Drums", channels: 2 },
];
const UNIT = { t1: 0, t2: 1, t3: 2, drums: 3 };        // sloop_plugin.c tutti_cap: the synth parts, the drum track
export const MAX_SECONDS = 600, MAX_TAIL_MS = 10000;
// every render plays from beat 0 (no seek): the frames before fromBeat are work too (protocol 6 counts the pre-roll in
// a render's length). At most the budget of a result plus its longest tail, at the render's tempo: a render's whole
// run stays within 1210 s of audio
export const MAX_PREROLL_SECONDS = MAX_SECONDS + MAX_TAIL_MS / 1000;
export const MIN_BPM = 40, MAX_BPM = 240;              // SLOOP's tempo range (sloop_plugin.c tutti_bpm_min/max)
export const BLOCK = 32;                               // the firmware's control block (sloop_plugin.c tutti_block_frames)
// what a use A render plays (state.js meta.play): the song if it is valid else the pattern, the song, the working
// pattern, a section looped -> sloop_plugin.c tutti_mode
export const PLAY_MODE = { auto: 0, song: 0, pattern: 1, A: 2, B: 3, C: 4, D: 5 };

export class RenderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// ------------------------------------------------------------------ the time map (protocol 5)
const finite = (x) => typeof x === "number" && Number.isFinite(x);

export function checkTimeMap(tm) {
  const pts = tm && tm.tempoPoints;
  if (!Array.isArray(pts) || !pts.length || pts[0].beat !== 0) throw new RenderError("bad-request", "tempoPoints: the first at beat 0");
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || !finite(p.beat) || !finite(p.bpm) || p.bpm <= 0 || (p.ramp !== "step" && p.ramp !== "linear") ||
        (i && p.beat <= pts[i - 1].beat))
      throw new RenderError("bad-request", "tempoPoints: sorted, positive bpm, ramp step | linear");
  }
  return pts;
}
// the tempo in effect at beat b (protocol 4: 'linear' ramps in bpm over beats to the next point)
export function tempoAt(pts, b) {
  let i = 0;
  while (i + 1 < pts.length && pts[i + 1].beat <= b) i++;
  const p = pts[i], q = pts[i + 1];
  return p.ramp === "linear" && q ? p.bpm + ((q.bpm - p.bpm) * (b - p.beat)) / (q.beat - p.beat) : p.bpm;
}
// seconds from beat 0 to beat b
export function secAt(pts, b) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[i + 1], end = Math.min(b, q ? q.beat : Infinity);
    if (end <= p.beat) break;
    const db = end - p.beat;
    if (p.ramp === "linear" && q && q.bpm !== p.bpm) {
      const k = (q.bpm - p.bpm) / (q.beat - p.beat), bpmEnd = p.bpm + k * db;
      s += (60 / k) * Math.log(bpmEnd / p.bpm);        // the integral of 60 / (bpm0 + k x) dx
    } else s += (60 * db) / p.bpm;
    if (!q || b <= q.beat) break;
  }
  return s;
}
// the tempo changes somewhere in [from, to)
export function tempoChanges(pts, from, to) {
  const t0 = tempoAt(pts, from);
  return pts.some((p, i) => {
    const q = pts[i + 1];
    if (p.beat > from && p.beat < to && p.bpm !== t0) return true;            // a step (or a ramp's start) inside
    return p.ramp === "linear" && q && q.bpm !== p.bpm && q.beat > from && p.beat < to;   // a ramp over part of it
  });
}
export const frameAt = (pts, b, sr) => Math.round(secAt(pts, b) * sr);

// ------------------------------------------------------------------ a request -> what to render
// -> { bpm, rate, outputs, frames (the result's length), skip (frames of the plugin's own timeline before frame 0 of
//      the result, at `rate`), stop (toBeat at 44.1 kHz), events (use B: [{frame, status, d1, d2}] at 44.1 kHz, null
//      for use A) }
export function planRender(req, { tempoMap = "constant" } = {}) {
  if (!req || typeof req !== "object") throw new RenderError("bad-request", "no request");
  const { fromBeat, toBeat, tailMs, sampleRate, outputs } = req;
  if (!finite(fromBeat) || !finite(toBeat) || fromBeat < 0 || toBeat <= fromBeat)
    throw new RenderError("bad-request", "fromBeat < toBeat, both >= 0");
  if (!finite(tailMs) || tailMs < 0 || tailMs > MAX_TAIL_MS) throw new RenderError("bad-request", "tailMs: 0 .. 10000");
  if (!SAMPLE_RATES.includes(sampleRate)) throw new RenderError("unsupported", `sampleRate ${sampleRate}: ${SAMPLE_RATES.join(" or ")}`);
  if (!Array.isArray(outputs) || !outputs.length || new Set(outputs).size !== outputs.length ||
      outputs.some((o) => !OUTPUTS.some((x) => x.id === o)))
    throw new RenderError("bad-request", `outputs: a subset of ${OUTPUTS.map((o) => o.id).join(" ")}`);
  const pts = checkTimeMap(req.context && req.context.timeMap);
  const bpm = tempoAt(pts, fromBeat), changes = tempoChanges(pts, fromBeat, toBeat);
  const approx = req.approximation === "start-tempo";
  if (changes && tempoMap !== "full" && !approx)
    throw new RenderError("unsupported", "the tempo changes inside the range: SLOOP renders a constant tempo (approximation 'start-tempo')");
  if (!(bpm >= MIN_BPM && bpm <= MAX_BPM))
    throw new RenderError("unsupported", `${bpm} BPM at fromBeat: SLOOP plays ${MIN_BPM} .. ${MAX_BPM} BPM`);
  const sr = sampleRate, tail = Math.ceil((tailMs * sr) / 1000);
  // protocol 5: frame(beat) integrates the map from beat 0. With 'start-tempo' (protocol 7) frame() is a constant map at
  // the tempo at fromBeat: the range rendered at that tempo throughout, its length that tempo's (the host warps it)
  const own = (b) => Math.round(((b * 60) / bpm) * sr);  // the plugin's timeline: constant bpm from beat 0
  const body = approx ? own(toBeat) - own(fromBeat) : frameAt(pts, toBeat, sr) - frameAt(pts, fromBeat, sr);
  const frames = body + tail, skip = own(fromBeat), stop = Math.round(((toBeat * 60) / bpm) * NATIVE_RATE);
  // the device counts frames from beat 0 in uint32 (sloop_plugin.c tutti_start's stop, tutti_event's frames, ~0u: none)
  if (!(Math.round((((toBeat * 60) / bpm) + MAX_TAIL_MS / 1000) * NATIVE_RATE) < 0xFFFFFFFF))
    throw new RenderError("bad-request", "toBeat past what the device can count (2^32 frames from beat 0)");
  if (frames <= 0) throw new RenderError("bad-request", "an empty range");
  if (frames > MAX_SECONDS * sr) throw new RenderError("too-large", `${frames} frames: at most ${MAX_SECONDS} s`);
  if (skip > MAX_PREROLL_SECONDS * sr)
    throw new RenderError("too-large", `fromBeat ${fromBeat}: the pre-roll from beat 0 at most ${MAX_PREROLL_SECONDS} s`);
  return { bpm, rate: sr, outputs: outputs.slice(), frames, skip, body, stop,
           events: req.input ? midiEvents(req.input, bpm, toBeat) : null };
}

// use B: the notes (released at min(their end, toBeat)), CC and pitch bend, at 44.1 kHz frames of the plugin's
// timeline, in time order; at one frame: controllers, then note-offs, then note-ons; a sustain pedal let go at toBeat.
// A note's off comes a block after its on at least (protocol 7b: a note of length <= 0, negative too, still gets its
// off after its on; the firmware takes MIDI per block, so an off in the on's block would let it go before it sounded). Moved that way, an off never goes past the
// next on of its pitch on its channel: at that frame at the latest, before the on (it would cut that note)
export function midiEvents(input, bpm, toBeat) {
  const f = (b) => Math.round(((Math.max(0, b) * 60) / bpm) * NATIVE_RATE);
  const ev = [], ch = (c) => Number.isInteger(c) && c >= 0 && c <= 15;
  const int = (x, lo, hi) => Number.isInteger(x) && x >= lo && x <= hi;
  if (!Array.isArray(input.notes) || !Array.isArray(input.cc) || !Array.isArray(input.pitchBend))
    throw new RenderError("bad-request", "input: notes, cc, pitchBend");
  if (input.notes.length + input.cc.length + input.pitchBend.length > 30000)
    throw new RenderError("too-large", "input: at most 30000 events");
  const ons = new Map();                               // channel * 128 + pitch -> the on frames, sorted
  for (const n of input.notes) {
    if (!n || !finite(n.beat) || !finite(n.lengthBeats) || !int(n.pitch, 0, 127) ||
        !int(n.velocity, 1, 127) || !ch(n.channel))
      throw new RenderError("bad-request", "input.notes: beat, lengthBeats, pitch 0..127, velocity 1..127, channel 0..15");
    if (n.beat >= toBeat) continue;
    const k = n.channel * 128 + n.pitch;
    if (!ons.has(k)) ons.set(k, []);
    ons.get(k).push(f(n.beat));
  }
  for (const a of ons.values()) a.sort((x, y) => x - y);
  const nextOn = (k, on) => {                          // the first on of that key after frame `on`
    const a = ons.get(k);
    let lo = 0, hi = a.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] <= on) lo = m + 1; else hi = m; }
    return lo < a.length ? a[lo] : Infinity;
  };
  for (const n of input.notes) {
    if (n.beat >= toBeat) continue;
    const on = f(n.beat), end = f(Math.min(n.beat + Math.max(0, n.lengthBeats), toBeat));   // (< 0: as 0)
    const off = Math.max(end, Math.min(on + BLOCK, nextOn(n.channel * 128 + n.pitch, on)));
    ev.push({ frame: on, order: 2, status: 0x90 | n.channel, d1: n.pitch, d2: n.velocity });
    ev.push({ frame: off, order: 1, status: 0x80 | n.channel, d1: n.pitch, d2: 0 });
  }
  for (const c of input.cc) {
    if (!c || !finite(c.beat) || !ch(c.channel) || !int(c.cc, 0, 127) || !int(c.value, 0, 127))
      throw new RenderError("bad-request", "input.cc: beat, channel 0..15, cc 0..127, value 0..127");
    if (c.beat < toBeat) ev.push({ frame: f(c.beat), order: 0, status: 0xB0 | c.channel, d1: c.cc, d2: c.value });
  }
  // the range ends at toBeat: a channel's sustain pedal let go there (its later pedal-up is past it, dropped), before
  // the notes' offs at that frame, so nothing is held into the tail (seq.c: an off with the pedal down waits for the
  // pedal); their releases and the FX tails ring out as they would (no sound-off)
  const pedals = new Set(input.cc.filter((c) => c.cc === 64 && c.beat < toBeat).map((c) => c.channel));
  for (const c of [...pedals].sort((a, b) => a - b))
    ev.push({ frame: f(toBeat), order: 0, status: 0xB0 | c, d1: 64, d2: 0 });
  for (const p of input.pitchBend) {
    if (!p || !finite(p.beat) || !ch(p.channel) || !int(p.value, -8192, 8191))
      throw new RenderError("bad-request", "input.pitchBend: beat, channel 0..15, value -8192..8191");
    const v = p.value + 8192;
    if (p.beat < toBeat) ev.push({ frame: f(p.beat), order: 0, status: 0xE0 | p.channel, d1: v & 127, d2: v >> 7 });
  }
  ev.forEach((e, i) => (e.i = i));
  ev.sort((a, b) => a.frame - b.frame || a.order - b.order || a.i - b.i);
  return ev;
}

// ------------------------------------------------------------------ an instance
// a fresh device: the state's flash, booted headless, the tempo
export async function device(module, sectors, bpm) {
  const inst = await WebAssembly.instantiate(module, {});
  const ex = (inst.instance || inst).exports;
  ex._initialize();
  ex.dev_nor_erase();
  restoreSectors(new Uint8Array(ex.memory.buffer, ex.dev_nor(), ex.dev_nor_size()), sectors);
  ex.tutti_boot(1);
  if (!ex.tutti_tempo(bpm)) throw new RenderError("unsupported", `${bpm} BPM`);
  return ex;
}

// ------------------------------------------------------------------ a render
// state: { sectors, meta } (state.js). sink: { chunk(output, frameOffset, [L, R]) -> Promise (resolves when it may go
// on: the host's credit), progress(fraction), cancelled() -> boolean }. Chunks of at most `rate` frames, the outputs of
// one frameOffset together. Resolves when all are out; RenderError('cancelled' | 'internal') otherwise.
export async function render(module, state, req, sink, opts = {}) {
  const plan = planRender(req, opts);
  const { rate, frames, skip, outputs } = plan;
  const chunkFrames = opts.chunkFrames || rate;
  const meta = cleanMeta(state.meta);
  const main = await device(module, state.sectors, plan.bpm);
  const units = outputs.filter((o) => o !== "mix").map((o) => UNIT[o]);
  const buses = [];
  for (const u of units) buses.push({ u, ex: await device(module, state.sectors, plan.bpm) });
  if (plan.events) {
    for (const e of plan.events)
      if (!main.tutti_event(e.frame, e.status, e.d1, e.d2)) throw new RenderError("too-large", "too many MIDI events");
    // (use B: SLOOP's sequencer and the arranger never start, protocol 7b: only the host's MIDI plays; tutti_event
    // takes no realtime messages, so the MIDI cannot start them either). The host's note lifetimes over SLOOP's
    // latches: KBD HOLD / ARP HOLD off for the render, everything still held let go at toBeat (sloop_plugin.c)
    main.tutti_use_b(plan.stop);
  } else {
    main.tutti_mode(PLAY_MODE[meta.play]);
    main.tutti_start(plan.stop);                       // use A: from frame 0, stopped at toBeat (the tail rings out)
  }

  const B = main.tutti_block_frames(), MAXB = main.tutti_max_blocks(), LAT = main.tutti_latency();
  if (B !== BLOCK) throw new RenderError("internal", `blocks of ${B} frames`);
  // what the outputs are made from, at 44.1 kHz: the device's frames from LAT on (its frame LAT + i is the timeline's
  // frame i: the limiter's look-ahead compensated), skip + frames of them (resampled: as far as the last one reads)
  const resampled = rate !== NATIVE_RATE;
  const need = LAT + (resampled ? Resampler.inputFor(skip + frames) : skip + frames);
  const room = chunkFrames + 2 * MAXB * B;              // a stream's result frames not out yet, at most
  const streams = outputs.map((id) => ({
    id, unit: id === "mix" ? -1 : UNIT[id], rs: resampled ? new Resampler(skip) : null,
    l: new Float32Array(room), r: new Float32Array(room), n: 0,
  }));
  let made = 0, done = 0, lastYield = Date.now();      // 44.1 kHz device frames rendered; result frames out

  while (done < frames) {
    if (sink.cancelled()) throw new RenderError("cancelled", "cancelled");
    if (made < need) {
      const nb = Math.max(1, Math.min(MAXB, Math.ceil((need - made) / B))), n = nb * B;
      main.tutti_render(nb, buses.length ? 1 : 0);
      const g = new Int16Array(main.memory.buffer, main.tutti_song_g(), 64);
      for (const s of streams) {
        let ex = main, l = main.tutti_out_l(), r = main.tutti_out_r();
        if (s.unit >= 0) {                              // the unit's sums through its own buses
          ex = buses.find((b) => b.u === s.unit).ex;
          new Int16Array(ex.memory.buffer, ex.tutti_song_g(), 64).set(g);
          new Int32Array(ex.memory.buffer, ex.tutti_bus_in(), n * 6).set(new Int32Array(main.memory.buffer, main.tutti_cap(s.unit), n * 6));
          ex.tutti_stem_render(nb);
          l = ex.tutti_stem_l();
          r = ex.tutti_stem_r();
        }
        const lat = Math.max(0, Math.min(n, LAT - made));   // (the look-ahead's frames: not the timeline's)
        const L = new Float32Array(ex.memory.buffer, l + 4 * lat, n - lat), R = new Float32Array(ex.memory.buffer, r + 4 * lat, n - lat);
        const at = Math.max(0, made - LAT);             // the timeline's frame of L[0]
        const left = frames - done - s.n;              // result frames still to come into this stream
        if (s.rs) {
          s.rs.push(L, R);
          s.n += s.rs.take(s.l, s.r, s.n, left);
        } else {                                        // (the frames before fromBeat dropped)
          const i = Math.max(0, skip - at), k = Math.max(0, Math.min(L.length - i, left));
          s.l.set(L.subarray(i, i + k), s.n);
          s.r.set(R.subarray(i, i + k), s.n);
          s.n += k;
        }
      }
      made += n;
    }
    // the streams move together (the same input frames): whole chunks out, and the last one
    const n0 = streams[0].n;
    if (streams.some((s) => s.n !== n0)) throw new RenderError("internal", "the outputs went apart");
    let at = 0;
    while (n0 - at >= chunkFrames || (n0 - at > 0 && done + (n0 - at) === frames)) {
      const k = Math.min(chunkFrames, n0 - at);
      for (const s of streams) {
        const l = s.l.slice(at, at + k), r = s.r.slice(at, at + k);
        for (let i = 0; i < k; i++)
          if (!Number.isFinite(l[i]) || !Number.isFinite(r[i])) throw new RenderError("internal", `non-finite sample in ${s.id}`);
        await sink.chunk(s.id, done, [l, r]);
      }
      at += k;
      done += k;
    }
    if (at)
      for (const s of streams) {
        s.l.copyWithin(0, at, s.n);
        s.r.copyWithin(0, at, s.n);
        s.n -= at;
      }
    if (made >= need && done < frames && !at) throw new RenderError("internal", "the render ran out of input");
    // over the pre-roll and the range (no seek: every render runs from beat 0, protocol 6), out as the chunks go
    sink.progress(Math.min(made / need, (skip + done) / (skip + frames)));
    if (Date.now() - lastYield > 40) {                 // let a cancel (or the page) in
      lastYield = Date.now();
      await new Promise((res) => setTimeout(res, 0));
    }
  }
  sink.progress(1);
  return { frames, outputs };
}
