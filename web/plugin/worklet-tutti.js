// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin page's live SLOOP: sloop.wasm (sloop_plugin.c) as a device in an AudioWorklet, after Felucca's
// (weavejam/Felucca web/plugin/worklet-tutti.js). Its clock follows the audio asked for (the main loop, the editor's
// replies, the saves run as the frames go); messages:
//   load            {wasm (bytes, the first time), state ({sectors, meta}), master}: a fresh device with this state
//   sysex           {data}: a frame for the device (the editor's request), in order; one at a time (the device holds
//                   one), the next when it has taken the last
//   midi            {data}: a channel message (the editor's keys)
//   master          {k10}: the page's volume (MASTER as its knob, 0..1023)
//   mode            {mode}: what PLAY plays (the state's `play` as renderer.js PLAY_MODE has it: the song, the working
//                   pattern, a section; sloop_plugin.c tutti_live_mode), from the next start; playing, it starts again
//                   where it is
//   tutti-tempo     {bpm}: the host's tempo (fractional)
//   tutti-play      {gen, playing, atFrame, pos}: the host's transport, listen-only: play from `pos` (frames of 44.1 kHz
//                   from beat 0) at this context's frame `atFrame`; the same generation again: only a drift of over
//                   20 ms moves it (re-seek); not playing: stop. A seek runs the sequencer up to `pos` at most
//                   SEEK_BLOCKS blocks per render quantum (sloop_plugin.c tutti_seek_run), silent until it is there
//   tutti-snapshot  {id}: what is only in RAM written to the flash, the storage sectors back
//   tutti-beats     {id, mode}: the beats one pass of what `mode` plays takes (sloop_plugin.c tutti_play_beats)
// and out: {type: ready}, {type: sysex, data}, {type: tutti-sig, sig} when the state changed, {type: tutti-snapshot,
// id, ok, sectors}, {type: tutti-beats, id, beats}, {type: playing, on}, {type: error, message}.
import { storeSectors, restoreSectors } from "./state.js";

const DRIFT = 0.02;                                    // s
const SEEK_BLOCKS = 1024;                              // a seek's blocks per render quantum
const SIG_QUANTA = 64;                                 // how often the state's signature is looked at (~190 ms)
const PANEL_HOLD_MS = 20;                              // a press of the hardware's (protocol 12) stays in this long
const PANEL_QUANTA = 11;                               // the screen / LEDs for the hardware: every ~32 ms at 44.1 kHz

class SloopTutti extends AudioWorkletProcessor {
  constructor() {
    super();
    this.module = null;
    this.ex = null;
    this.bpm = 0;
    this.master = 724;                                 // MASTER, 0..1023 (sloop_plugin.c dev_master)
    this.mode = 0;
    this.sx = [];                                      // frames waiting for the device
    this.play = null;                                  // a start to come: {gen, atFrame, pos}
    this.at = null;                                    // playing: {gen, frame, pos} (pos at that frame)
    this.seeking = null;                               // a seek on its way: {gen, frame, pos}
    this.sentSig = null;
    this.quanta = 0;
    this.playing = 0;
    // a hardware FM-1 through tuttidaw (protocol 12, fm1-panel.js): the panel's presses held at least PANEL_HOLD_MS of
    // the device's time each (its main loop reads them every 15 ms: a tap is never lost), the screen and LEDs out
    this.panelOn = false;
    this.inq = [];
    this.nextOk = 0;
    this.pq = 0;
    this.sentDraws = -1;
    this.sentLeds = "";
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  async onMessage(m) {
    try {
      if (m.type === "load") return await this.load(m);
      if (m.type === "tutti-tempo") {
        this.bpm = m.bpm;
        if (this.ex) this.ex.tutti_tempo(m.bpm);       // (out of SLOOP's range: refused, the tempo stays)
        return;
      }
      if (m.type === "master") {                       // (the page's volume: k10; the FM-1's pot: value)
        this.master = m.k10 ?? m.value;
        if (this.ex) this.ex.dev_master(this.master);
        return;
      }
      if (m.type === "panel") {
        this.panelOn = !!m.on;
        this.sentDraws = -1;
        this.sentLeds = "";
        if (this.ex) this.ex.dev_panel(this.panelOn ? 1 : 0);
        return;
      }
      if (m.type === "mode") { this.mode = m.mode >>> 0; if (this.ex) this.setMode(); return; }
      const ex = this.ex;
      if (!ex) return;
      if (m.type === "sysex") { this.sx.push(m.data); this.pump(); return; }
      if (m.type === "midi") { const d = m.data; ex.dev_midi(d[0], d[1] ?? 0, d[2] ?? 0); return; }
      if (m.type === "buttons" || m.type === "keys") { this.inq.push(m); return; }
      if (m.type === "enc") { ex.dev_turn(m.role >>> 0, m.n | 0); return; }
      if (m.type === "tutti-play") return this.schedule(m);
      if (m.type === "tutti-snapshot") {
        const ok = ex.tutti_snapshot();
        const sectors = storeSectors(new Uint8Array(ex.memory.buffer, ex.dev_nor(), ex.dev_nor_size()));
        this.sentSig = ex.tutti_sig() >>> 0;
        this.port.postMessage({ type: "tutti-snapshot", id: m.id, ok: !!ok, sectors, sig: this.sentSig });
        return;
      }
      if (m.type === "tutti-beats") { this.port.postMessage({ type: "tutti-beats", id: m.id, beats: ex.tutti_play_beats(m.mode) }); return; }
    } catch (err) {
      this.port.postMessage({ type: "error", message: String(err && err.message || err) });
    }
  }

  async load(m) {
    if (m.wasm) this.module = await WebAssembly.compile(m.wasm);
    const { exports: ex } = await WebAssembly.instantiate(this.module, {});
    ex._initialize();
    ex.dev_nor_erase();
    restoreSectors(new Uint8Array(ex.memory.buffer, ex.dev_nor(), ex.dev_nor_size()), m.state.sectors);
    ex.tutti_boot(0);
    if (m.master != null) this.master = m.master;
    ex.dev_master(this.master);
    if (this.bpm) ex.tutti_tempo(this.bpm);
    if (m.mode != null) this.mode = m.mode >>> 0;
    ex.tutti_live_mode(this.mode);
    ex.dev_panel(this.panelOn ? 1 : 0);                // (a new device: the hardware's screen as it was)
    this.inq = [];
    this.sentDraws = -1;
    this.sentLeds = "";
    this.ex = ex;
    this.L = new Float32Array(ex.memory.buffer, ex.dev_out_l(), 128);
    this.R = new Float32Array(ex.memory.buffer, ex.dev_out_r(), 128);
    this.sx = [];
    this.play = this.at = this.seeking = null;
    this.sentSig = ex.tutti_sig() >>> 0;
    this.playing = 0;
    this.port.postMessage({ type: "ready", rate: ex.dev_sample_rate(), sig: this.sentSig });
  }

  // the editor's frames into the device, one at a time; what it sent back out
  pump() {
    const ex = this.ex;
    while (this.sx.length) {
      const d = this.sx[0], mem = new Uint8Array(ex.memory.buffer);
      if (d.length > 1024) { this.sx.shift(); continue; }
      mem.set(d, ex.dev_sysex_in());
      if (!ex.dev_sysex(d.length)) break;              // (the device still holds the last one: the next quantum)
      this.sx.shift();
    }
    this.out();
  }
  out() {
    const ex = this.ex, n = ex.dev_sysex_out_len();
    if (!n) return;
    const data = new Uint8Array(ex.memory.buffer, ex.dev_sysex_out(), n).slice();
    ex.dev_sysex_clear();
    this.port.postMessage({ type: "sysex", data }, [data.buffer]);
  }

  // the panel's presses in, one change per PANEL_HOLD_MS; the screen and LEDs out ~30 times a second while shown
  panel() {
    const ex = this.ex, now = ex.dev_now_ms();
    while (this.inq.length && now - this.nextOk >= 0) {
      const m = this.inq.shift();
      if (m.type === "buttons") ex.dev_buttons(m.mask >>> 0);
      else ex.dev_keys(m.mask >>> 0);
      this.nextOk = now + PANEL_HOLD_MS;
    }
    if (!this.panelOn || ++this.pq < PANEL_QUANTA) return;
    this.pq = 0;
    const msg = { type: "frame" }, transfer = [];
    const draws = ex.dev_screen_draws();
    if (draws !== this.sentDraws) {
      this.sentDraws = draws;
      msg.fb = new Uint16Array(ex.memory.buffer, ex.dev_screen(), 240 * 240).slice();
      transfer.push(msg.fb.buffer);
    }
    const leds = Array.from(new Uint32Array(ex.memory.buffer, ex.dev_leds(), 8));
    const key = leds.join(",");
    if (key !== this.sentLeds) {
      this.sentLeds = key;
      msg.leds = leds;
    }
    if (msg.fb || msg.leds) this.port.postMessage(msg, transfer);
  }

  // what PLAY plays changed: playing, the same run starts again where it is now (the next quantum), with it
  setMode() {
    this.ex.tutti_live_mode(this.mode);
    const run = this.at || this.seeking;
    if (run && !this.play) this.play = { gen: run.gen, atFrame: currentFrame, pos: run.pos + (currentFrame - run.frame) };
  }

  schedule(m) {
    if (!m.playing) {
      this.play = null;
      if (this.at || this.seeking) this.ex.tutti_seek(0, 0);
      this.at = this.seeking = null;
      return;
    }
    const run = this.at || this.seeking;
    if (run && run.gen === m.gen) {                    // still the same run: only a drift moves it
      const ours = run.pos + (m.atFrame - run.frame);
      if (Math.abs(ours - m.pos) <= DRIFT * sampleRate) return;
    }
    this.play = { gen: m.gen, atFrame: m.atFrame, pos: m.pos };
  }

  process(inputs, outputs) {
    const ex = this.ex, out = outputs[0];
    if (!ex) return true;
    const p = this.play;
    let left = 0;                                      // a seek's blocks still to run
    if (p && currentFrame + 128 > p.atFrame) {         // (the quantum it starts in)
      this.play = this.at = null;
      const pos = Math.max(0, Math.round(p.pos + (currentFrame - p.atFrame)));
      ex.tutti_live_mode(this.mode);                   // (as it is now: a song or a section stored since counts)
      ex.tutti_seek(1, pos);
      this.seeking = { gen: p.gen, frame: currentFrame, pos };
      left = ex.tutti_seek_run(SEEK_BLOCKS, 0);
    } else if (this.seeking)                           // on with it, the last (silent) quantum's time added
      left = ex.tutti_seek_run(SEEK_BLOCKS, out[0].length / ex.tutti_block_frames());
    if (this.seeking) {
      if (left) return true;                           // not there yet: silence (the outputs are zeros)
      const s = this.seeking;
      this.seeking = null;
      this.at = { gen: s.gen, frame: currentFrame, pos: s.pos + (currentFrame - s.frame) };
    }
    if (this.sx.length) this.pump();
    const n = out[0].length;
    ex.dev_render(n);
    if (this.L.buffer !== ex.memory.buffer) {
      this.L = new Float32Array(ex.memory.buffer, ex.dev_out_l(), 128);
      this.R = new Float32Array(ex.memory.buffer, ex.dev_out_r(), 128);
    }
    out[0].set(this.L.subarray(0, n));
    if (out[1]) out[1].set(this.R.subarray(0, n));
    this.out();
    this.panel();
    if (++this.quanta >= SIG_QUANTA) {
      this.quanta = 0;
      const sig = ex.tutti_sig() >>> 0, playing = ex.dev_playing();
      if (sig !== this.sentSig) {
        this.sentSig = sig;
        this.port.postMessage({ type: "tutti-sig", sig });
      }
      if (playing !== this.playing) {
        this.playing = playing;
        this.port.postMessage({ type: "playing", on: !!playing });
      }
    }
    return true;
  }
}
registerProcessor("sloop-tutti", SloopTutti);
