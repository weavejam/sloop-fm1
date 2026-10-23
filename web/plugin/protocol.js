// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// tutti-plugin/0, the plugin's side (docs: the host's protocol-v0.md; web/plugin/README.md): the handshake (hello ->
// connect with a MessagePort), the session's requests and replies, the state machine, renders streamed in credited
// chunks. No DOM here: the page (tutti.js) hands it window messages and an engine; the tests (plugin_test.mjs) a fake
// host over a MessageChannel.
//   engine: {
//     init({ sampleRate, context, state, stateVersion, mode }) -> { stateRevision }      (throws StateError)
//     context(context), transport(transport)                                              (no reply)
//     getState() -> { state: ArrayBuffer, stateVersion, stateRevision, summary? }
//     render(request, sink) -> { frames, outputs }   sink: chunk(output, frameOffset, channels) -> Promise, progress(f),
//                                            cancelled(); throws RenderError(code) (renderer.js)
//     close()
//   }
// and calls back: session.stateChanged(revision), session.commit({ fromBeat?, toBeat?, outputs? }),
// session.resize(width, height).
// Each session has a token (this.sess); a request keeps the one it came in with, and what it sends after an await goes
// to that session only: nothing once it has ended, never into a later session.
export const PROTOCOL = "tutti-plugin/0";
export const CODES = ["bad-request", "unsupported", "busy", "state-incompatible", "cancelled", "too-large", "timeout",
                      "session-ended", "internal"];
export const INITIAL_CREDITS = 8;
// the credits a render may hold (protocol 6: no more chunks in flight than granted): the chunks of the largest render of
// the host's budget, 600 s in 1 s chunks of 8 outputs; grants past it are clamped (a credit beyond is never used)
export const MAX_CREDITS = 600 * 8;
export const STATE_DEBOUNCE_MS = 600, STATE_MAX_WAIT_MS = 2000, PROGRESS_MS = 100;

// The pages that may embed it (protocol 3), per deployment channel: chosen when the site is built (site.mjs
// PLUGIN_CHANNEL), which writes the channel's list into the page's build-info.js (EMBEDDERS) and into _headers'
// frame-ancestors. Exact origins; "http://localhost:*" is a local dev server on any port (preview only, never production)
export const CHANNELS = {
  production: ["https://tuttidaw.com", "https://www.tuttidaw.com"],
  preview: ["https://tuttidaw.com", "https://www.tuttidaw.com", "http://localhost:*"],
};
export function embedderAllowed(origin, embedders = CHANNELS.production) {
  if (typeof origin !== "string") return false;
  return embedders.some((e) => e === "http://localhost:*" ? /^http:\/\/localhost(:\d{1,5})?$/.test(origin) : e === origin);
}

const isStr = (x) => typeof x === "string" && x.length > 0 && x.length <= 200;
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

export class PluginSession {
  // post(message): to window.parent, target '*' (the hello only); allow(origin): an embedder (embedderAllowed with the
  // build's list); log(...): a console
  constructor({ engine, post, plugin, allow = embedderAllowed, log = () => {}, now = () => Date.now(), panel = null }) {
    this.engine = engine;
    this.panel = panel;                               // a hardware FM-1 (fm1-panel.js PanelBridge; protocol 12), or none
    this.postParent = post;
    this.plugin = plugin;                             // { id, version, build }
    this.allow = allow;
    this.log = log;
    this.now = now;
    this.port = null;
    this.id = null;
    this.sess = null;                                  // the live session's token ({ id }), null between sessions
    this.accepting = true;                             // false: the page went standalone, no connects any more
    this.state = "connecting";                         // -> initializing -> ready (-> rendering -> ready) -> closed
    this.render = null;                                // the render running: { id, renderId, credits, cancel, ... }
    this.stTimer = null;
  }

  hello() { this.postParent({ type: "tutti-plugin:hello", protocol: PROTOCOL }); }
  stopAccepting() { this.accepting = false; }

  // a window message: { data, origin, isParent (event.source === window.parent), ports }. 1 = it was taken. The session
  // ends on close, the page going (pagehide) or a port error (messageerror; protocol 3): close()
  onWindowMessage({ data, origin, isParent, ports }) {
    if (!data || data.type !== "tutti-plugin:connect") return 0;
    if (!isParent || !this.allow(origin)) { this.log("tutti: connect refused from", origin); return 0; }
    if (!this.accepting) { this.log("tutti: a connect after going standalone refused"); return 0; }
    if (this.port) { this.log("tutti: a second connect ignored"); return 0; }
    if (data.protocol !== PROTOCOL || !isStr(data.sessionId) || !isNum(data.generation) || !ports || !ports[0]) {
      this.log("tutti: a malformed connect ignored");
      return 0;
    }
    this.id = data.sessionId;
    this.sess = { id: data.sessionId };
    this.render = null;
    this.generation = data.generation;
    this.host = data.host || null;
    this.origin = origin;
    this.port = ports[0];
    this.state = "initializing";                       // (until init:ok; requests before it: bad-request)
    this.inited = false;
    this.initing = false;
    this.port.onmessage = (e) => this.onPort(e.data);
    this.port.onmessageerror = () => { this.log("tutti: a message the port could not read: the session ends"); this.close(); };
    if (this.port.start) this.port.start();
    return 1;
  }

  // to session `sess` (by default the live one; a request passes the one it came in with)
  send(msg, transfer = [], sess = this.sess) {
    if (!this.live(sess) || !this.port) return;         // (that session ended: nothing more, not into another)
    this.port.postMessage({ ...msg, sessionId: sess.id }, transfer);
  }
  error(code, message, extra = {}, fatal = false, sess = this.sess) {
    this.send({ type: "error", code, message: String(message).slice(0, 500), fatal, ...extra }, [], sess);
  }
  live(sess) { return !!sess && sess === this.sess && this.state !== "closed"; }

  async onPort(m) {
    if (this.state === "closed") return;
    const sess = this.sess;
    if (!m || typeof m !== "object" || typeof m.type !== "string") { this.log("tutti: dropped", m); return; }
    if (m.sessionId !== this.id) { this.log("tutti: dropped (session)", m.type); return; }
    const requests = ["init", "get-state", "render"];
    if (requests.includes(m.type) && !isStr(m.id)) { this.error("bad-request", `${m.type} without an id`); return; }
    if (m.type !== "init" && m.type !== "close" && !this.inited) {
      if (requests.includes(m.type)) this.error("bad-request", "before init", { id: m.id });
      else this.log("tutti: dropped before init", m.type);
      return;
    }
    try {
      switch (m.type) {
        case "init": return await this.onInit(m, sess);
        case "context":
          if (!m.context || typeof m.context !== "object") return this.log("tutti: dropped context");
          return this.engine.context(m.context);
        case "transport":
          if (!isNum(m.generation) || typeof m.playing !== "boolean" || !isNum(m.beat) || !isNum(m.atEpochMs))
            return this.log("tutti: dropped transport");
          return this.engine.transport(m);
        case "get-state": return await this.onGetState(m, sess);
        case "render": return await this.onRender(m, sess);
        case "render-credit": {
          const r = this.render;
          if (r && r.renderId === m.renderId && Number.isInteger(m.chunks) && m.chunks > 0 && m.chunks <= 1e6) {
            r.credits = Math.min(MAX_CREDITS, r.credits + m.chunks);
            r.wake();
          } else this.log("tutti: dropped render-credit");
          return;
        }
        case "cancel": {
          const r = this.render;
          if (r && r.renderId === m.renderId) { r.cancel = true; r.wake(); }
          return;
        }
        case "panel-attach":                         // (protocol 12: the host's FM-1 is this panel now / no longer)
          if (typeof m.attached !== "boolean") return this.log("tutti: dropped panel-attach");
          if (this.panel) this.panel.attach(m.attached);
          return;
        case "panel":
          if (!Array.isArray(m.events)) return this.log("tutti: dropped panel");
          if (this.panel) this.panel.events(m.events);
          return;
        case "close": return this.close();
        default: this.log("tutti: unknown message", m.type);
      }
    } catch (err) {
      this.log("tutti: internal", err);
      if (requests.includes(m.type)) this.error("internal", err && err.message || err, { id: m.id }, false, sess);
    }
  }

  async onInit(m, sess) {
    if (this.inited || this.state !== "initializing" || this.initing) { this.error("bad-request", "init twice", { id: m.id }); return; }
    const { sampleRate, context, state, stateVersion, mode } = m;
    if (!isNum(sampleRate) || !context || typeof context !== "object" || (mode !== "edit" && mode !== "render") ||
        !(state === null || state instanceof ArrayBuffer) || !(stateVersion === null || isNum(stateVersion)) ||
        (state !== null && stateVersion === null)) {
      this.error("bad-request", "init: sampleRate, context, state, stateVersion, mode", { id: m.id });
      return;
    }
    if (state && state.byteLength > 8388608) { this.error("too-large", "state over 8 MiB", { id: m.id }); return; }
    this.initing = true;
    this.mode = mode;
    try {
      const r = await this.engine.init({ sampleRate, context, state, stateVersion, mode });
      if (!this.live(sess)) return;                    // (its session ended meanwhile: a later one stays uninited)
      this.inited = true;
      this.state = "ready";
      this.send({ type: "init:ok", id: m.id, plugin: this.plugin, stateRevision: r.stateRevision }, [], sess);
    } catch (err) {
      const code = err && CODES.includes(err.code) ? err.code : "internal";   // (StateError: state-incompatible)
      if (code === "internal") this.log("tutti: init failed", err);
      this.error(code, err && err.message || err, { id: m.id }, code === "internal", sess);
    } finally {
      if (sess === this.sess) this.initing = false;
    }
  }

  async onGetState(m, sess) {
    const s = await this.engine.getState();
    this.send({ type: "get-state:ok", id: m.id, state: s.state, stateVersion: s.stateVersion, stateRevision: s.stateRevision,
                ...(s.summary ? { summary: s.summary } : {}) }, [s.state], sess);
  }

  async onRender(m, sess) {
    if (!isStr(m.renderId) || !isNum(m.stateRevision) || !m.context || !Array.isArray(m.outputs) ||
        !isNum(m.fromBeat) || !isNum(m.toBeat) || !isNum(m.tailMs) || !isNum(m.sampleRate) ||
        !(m.input === null || (m.input && typeof m.input === "object"))) {
      this.error("bad-request", "render: renderId, stateRevision, context, input, fromBeat, toBeat, tailMs, outputs, sampleRate",
                 { id: m.id, ...(isStr(m.renderId) ? { renderId: m.renderId } : {}) });
      return;
    }
    if (this.render) { this.error("busy", "a render is running", { id: m.id, renderId: m.renderId }); return; }
    let wake = () => {};
    const r = this.render = { id: m.id, renderId: m.renderId, credits: INITIAL_CREDITS, cancel: false,
                              wake: () => wake(), lastProgress: -Infinity };
    this.state = "rendering";
    const sink = {
      cancelled: () => r.cancel || !this.live(sess),
      progress: (f) => {
        const t = this.now();
        if (t - r.lastProgress < PROGRESS_MS && !(f >= 1 && !r.sentAll)) return;   // (the last, 1, always out)
        if (f >= 1) r.sentAll = true;
        r.lastProgress = t;
        this.send({ type: "render-progress", renderId: r.renderId, fraction: Math.max(0, Math.min(1, f)) }, [], sess);
      },
      chunk: async (output, frameOffset, channels) => {
        while (r.credits <= 0 && !sink.cancelled()) await new Promise((res) => { wake = res; });
        if (sink.cancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
        r.credits--;
        this.send({ type: "render-chunk", renderId: r.renderId, output, frameOffset, channels },
                  channels.map((c) => c.buffer), sess);
      },
    };
    try {
      const res = await this.engine.render(m, sink);
      if (sink.cancelled()) throw Object.assign(new Error("cancelled"), { code: "cancelled" });
      if (!res || !Number.isInteger(res.frames) || !Array.isArray(res.outputs))
        throw new Error("the render gave no frames and outputs");
      // protocol 6: frames per output (the tail in), the outputs, the build; after the last chunk
      this.send({ type: "render:ok", id: r.id, renderId: r.renderId, frames: res.frames, outputs: res.outputs.slice(),
                  build: this.plugin.build }, [], sess);
    } catch (err) {
      const code = err && CODES.includes(err.code) ? err.code : "internal";
      if (code === "internal") this.log("tutti: render failed", err);
      this.error(code, err && err.message || err, { id: r.id, renderId: r.renderId }, false, sess);
    } finally {
      if (this.render === r) {                         // (not a later session's render)
        this.render = null;
        if (this.state === "rendering") this.state = "ready";
      }
    }
  }

  // ---- from the plugin
  // the state changed: state-changed once it has been still for STATE_DEBOUNCE_MS (at most every STATE_MAX_WAIT_MS
  // while it keeps changing), with the revision at that moment
  stateChanged(revision) {
    if (!this.inited || this.state === "closed") return;
    const t = this.now(), sess = this.sess;
    this.stFirst = this.stFirst || t;
    this.stRevision = revision;
    clearTimeout(this.stTimer);
    const fire = () => {
      this.stTimer = null;
      this.stFirst = 0;
      this.send({ type: "state-changed", stateRevision: this.stRevision }, [], sess);
    };
    const wait = Math.min(STATE_DEBOUNCE_MS, Math.max(0, this.stFirst + STATE_MAX_WAIT_MS - t));
    this.stTimer = setTimeout(fire, wait);
  }
  commit(p = {}) {
    if (!this.inited || !this.live(this.sess)) return false;
    const msg = { type: "commit" };
    if (isNum(p.fromBeat)) msg.fromBeat = p.fromBeat;
    if (isNum(p.toBeat)) msg.toBeat = p.toBeat;
    if (Array.isArray(p.outputs)) msg.outputs = p.outputs;
    this.send(msg);
    return true;
  }
  resize(width, height) {
    this.send({ type: "resize", width: Math.round(width), height: Math.round(height) });
  }
  close() {
    if (this.state === "closed") return;
    if (this.panel) this.panel.attach(false);          // (the hardware lets go with the session)
    if (this.render) { this.render.cancel = true; this.render.wake(); }
    clearTimeout(this.stTimer);
    this.stTimer = null;
    this.stFirst = 0;
    this.state = "closed";
    this.sess = null;                                  // (what its requests still send goes nowhere)
    this.render = null;
    this.inited = this.initing = false;
    try { this.engine.close(); } catch {}
    if (this.port) { this.port.onmessage = this.port.onmessageerror = null; try { this.port.close(); } catch {} }
    this.port = null;                                  // (a new connect may start another session)
  }
}
