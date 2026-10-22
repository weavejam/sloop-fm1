// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// SLOOP behind a session (protocol.js engine), after Felucca's (weavejam/Felucca web/plugin/engine.js): the state and
// its revisions, renders of a revision's state, the live device of the page (edit mode) when there is one.
//   render(state, request, sink) -> result      renderer.js render, here or in a Worker (render-worker.js)
//   live (edit mode, the page; null headless): {
//     load(state, context) -> Promise          (re)start the live device with this state ({sectors, meta}, state.js)
//     snapshot() -> Promise<state>             its state now (sloop_plugin.c tutti_snapshot; the page's meta)
//     context(context), transport(transport)   the host's tempo, its transport (preview, listen-only)
//     close()
//   } and it calls engine.changed() when its music, flash or the plugin's settings changed (the page's check, tutti.js)
// A revision is a state the host may ask a render of: 1 the one init gave (or the factory state), +1 when the live
// device changed since the last revision; its bytes are made when the host asks for them (get-state) or renders it,
// once: what asks for that revision meanwhile waits for the same snapshot (a revision is one state, published once).
import { packState, unpackState, STATE_VERSION, DEFAULT_META, StateError } from "./state.js";
import { RenderError, checkTimeMap, tempoAt, MIN_BPM, MAX_BPM } from "./renderer.js";

const KEEP = 8;                                        // revisions whose states are kept for renders

export class SloopEngine {
  constructor({ render, live = null, onChanged = () => {}, name = () => null }) {
    this.renderFn = render;
    this.live = live;
    this.onChanged = onChanged;                        // (revision): the session's state-changed
    this.name = name;
    this.revision = 0;
    this.states = new Map();                           // revision -> { rev, buf, state }
    this.dirty = false;                                // the live device changed since `revision` was made
    this.epoch = 0;                                    // +1 per init: what an earlier session's await gives is dropped
    this.making = new Map();                           // revision -> its snapshot on the way (this session's)
  }

  async init({ context, state, stateVersion, mode }) {
    const st = state ? unpackState(state, stateVersion) : { sectors: {}, meta: { ...DEFAULT_META } };
    this.mode = mode;
    this.ctx = context;                                // (not `context`: that is the method)
    this.epoch++;
    this.revision = 1;
    this.dirty = false;
    this.states.clear();
    this.making.clear();                               // (an earlier session's snapshot: dropped when it comes)
    this.keep(1, { rev: 1, buf: state ? state.slice(0) : packState(st), state: st });   // (the input is never changed)
    if (mode === "edit" && this.live) await this.live.load(st, context);
    return { stateRevision: this.revision };
  }

  keep(rev, s) {
    this.states.set(rev, s);
    for (const k of [...this.states.keys()]) if (k <= rev - KEEP) this.states.delete(k);
  }

  // the live device changed (its music, a saved preset, a setting, what a render plays): a new revision from now
  changed() {
    if (!this.revision) return;
    if (!this.dirty) {
      this.dirty = true;
      this.revision++;
    }
    this.onChanged(this.revision);
  }

  // the state of the current revision ({ rev, buf, state }), made now if it is not yet: kept as the revision current
  // when it was asked for; if its session ended meanwhile (another init), dropped, never kept. One snapshot per
  // revision: asked for again while it is made, the same one (a revision's bytes are made once, never two states)
  current() {
    const have = this.states.get(this.revision);
    if (have && !this.dirty) return Promise.resolve(have);
    if (!this.live || this.mode !== "edit") return Promise.resolve(have);
    if (!this.dirty && this.making.has(this.revision)) return this.making.get(this.revision);
    this.dirty = false;                                // (a change from here on: the next revision)
    const epoch = this.epoch, rev = this.revision;
    const p = (async () => {
      try {
        const st = await this.live.snapshot();
        if (epoch !== this.epoch) throw new RenderError("session-ended", "the session ended");
        const s = { rev, buf: packState(st), state: st };
        this.keep(rev, s);
        return s;
      } finally {
        if (this.making.get(rev) === p) this.making.delete(rev);
      }
    })();
    this.making.set(rev, p);
    return p;
  }

  async getState() {
    const s = await this.current();
    const name = this.name();
    return { state: s.buf.slice(0), stateVersion: STATE_VERSION, stateRevision: s.rev,
             ...(name ? { summary: { name } } : {}) };
  }

  context(ctx) {
    this.ctx = ctx;
    if (this.live) this.live.context(ctx);
  }
  transport(t) { if (this.live) this.live.transport(t); }

  async render(req, sink) {
    let s = this.states.get(req.stateRevision);
    if (req.stateRevision === this.revision) s = await this.current();
    else if (!s && this.making.has(req.stateRevision)) s = await this.making.get(req.stateRevision);   // (changed since)
    if (sink.cancelled()) throw new RenderError("cancelled", "cancelled");   // (its session ended while the state was made)
    if (!s) throw new RenderError("state-incompatible", `state revision ${req.stateRevision} is not known (now ${this.revision})`);
    return this.renderFn(s.state, req, sink);
  }

  close() { if (this.live) this.live.close(); }
}

// the live preview's tempo (tutti.js live): the host's time map (`context`) and the tempo at a beat, within SLOOP's
// range; send(bpm) when it changes
export class PreviewTempo {
  constructor(send) {
    this.send = send;
    this.pts = [{ beat: 0, bpm: 120, ramp: "step" }];
    this.bpm = 0;                                      // the one sent (0: none yet)
  }
  context(ctx) {
    try { this.pts = checkTimeMap(ctx && ctx.timeMap); } catch { return; }
    this.at(0);
  }
  at(beat) {
    const b = Math.min(MAX_BPM, Math.max(MIN_BPM, tempoAt(this.pts, beat)));
    if (b !== this.bpm) { this.bpm = b; this.send(b); }
  }
  reset() { this.bpm = 0; }                            // (a new device: the tempo sent again)
}

export { StateError };
