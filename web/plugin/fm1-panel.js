// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// A hardware FM-1 through tuttidaw (tutti-plugin/0 section 12, docs/plugins/protocol-v0.md in tuttidaw): while this
// plugin's window has the focus, the host's FM-1 (RemoteFM1) is this panel - its buttons, keys, encoders and MASTER go
// into the emulator like the on-screen ones, and the emulator's screen and LEDs go back to the unit.
//   - inputs by printed label: buttons fx .. octUp (bit b = the emulator's web_buttons bit b, panel.c B_FX ..), encoders
//     select algorithm presets knob1..4 (web_enc's roles EN_SELECT ..), keys 0..26, MASTER 0..1023;
//   - a control is held while the hardware or the page holds it: the hardware's masks go to the worklet `direct`, which
//     keeps them apart from the page's own (its clicks, the computer keys), ORs the two and applies the hardware's at
//     once - the page's stay queued there, each held HOLD_MS, which hardware playing must not wait behind;
//   - `panel-frame`: the screen (240 x 240 RGB565 values; the worklet's fb holds each pixel in the panel's byte order,
//     high byte first, so each is swapped - as web/emu/index.html does to paint it) and the LEDs (the worklet's leds:
//     lit / dim masks), only while attached, when they change, at most 30 a second; detaching lifts what the hardware
//     holds.
// Shared as is by Felucca, JIANT FM and SLOOP (the same emulator interface: web/emu/worklet.js).

export const BUTTONS = ["fx", "scl", "env", "lfo", "edit", "glo", "home", "save", "arp", "seq", "play", "rec",
                        "octDown", "octUp"];
export const ENCODERS = ["select", "algorithm", "presets", "knob1", "knob2", "knob3", "knob4"];
export const MAX_EVENTS = 64;
const FRAME_MS = 1000 / 30;
const ALL_KEYS = (1 << 27) - 1;

// the worklet's fb (each pixel high byte first, as the panel takes it) -> RGB565 values (protocol 12), a copy
export function screenRgb565(fb) {
  const out = new Uint16Array(fb.length);
  for (let i = 0; i < fb.length; i++) {
    const v = fb[i];
    out[i] = ((v >> 8) | (v << 8)) & 0xffff;
  }
  return out;
}

// the worklet's leds ([lit buttons | PLAY green << 14, lit keys, dim buttons, dim keys, dim level, breath buttons,
// breath keys, mid keys]) -> the protocol's (a lit LED is not also dim; breath and mid show as the glow)
export function panelLeds(a) {
  const litB = (a[0] >>> 0) & 0x3fff, litK = (a[1] >>> 0) & ALL_KEYS;
  return {
    buttons: { lit: litB, dim: (((a[2] | a[5]) >>> 0) & 0x3fff & ~litB) >>> 0 },
    keys: { lit: litK, dim: (((a[3] | a[6] | (a[7] || 0)) >>> 0) & ALL_KEYS & ~litK) >>> 0 },
    playGreen: ((a[0] >>> 14) & 1) === 1,
  };
}

function valid(e) {
  if (!e || typeof e !== "object") return false;
  if (e.kind === "button") return BUTTONS.includes(e.name) && typeof e.down === "boolean";
  if (e.kind === "key") return Number.isInteger(e.index) && e.index >= 0 && e.index < 27 && typeof e.down === "boolean";
  if (e.kind === "encoder") return ENCODERS.includes(e.name) && Number.isInteger(e.steps) && e.steps !== 0 &&
                                   Math.abs(e.steps) <= 63;
  if (e.kind === "master") return Number.isInteger(e.value) && e.value >= 0 && e.value <= 1023;
  return false;
}

export class PanelBridge {
  // send(msg, transfer): to the host (the session's send); onAttach(on): the page's own reaction (SLOOP's device draws
  // its screen only while shown); now / timers injectable for the tests
  constructor(send, { onAttach = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.send = send;
    this.onAttach = onAttach;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.post = null;                                  // to the live device's worklet (its own postMessage)
    this.attached = false;
    this.hw = { buttons: 0, keys: 0 };
    this.fb = null;
    this.leds = null;
    this.dirty = { screen: false, leds: false };
    this.timer = null;
    this.sentAt = -Infinity;
  }

  // the live device's worklet node (a new one: a new device, nothing held). The page's own presses go to it as they
  // did (queued there, each held a little: a click's down and up may come together); the hardware's go `direct` - the
  // worklet keeps the two apart and ORs them, and applies the hardware's at once (no queue: no lag when playing)
  node(n) {
    this.post = n.port.postMessage.bind(n.port);
    this.hw = { buttons: 0, keys: 0 };
    if (this.attached) this.onAttach(true);            // (a new device while shown: it shows too)
  }

  // a message from the worklet: its screen and LEDs as they change (a frame's fb is a copy of the device's)
  frame(m) {
    if (!m || m.type !== "frame") return;
    if (m.fb) {
      this.fb = m.fb;
      this.dirty.screen = true;
    }
    if (m.leds) {
      this.leds = panelLeds(m.leds);
      this.dirty.leds = true;
    }
    this.flush();
  }

  attach(on) {
    if (on === this.attached) return;
    this.attached = on;
    this.onAttach(on);
    if (on) {
      this.dirty = { screen: !!this.fb, leds: !!this.leds };
      this.sentAt = -Infinity;
      this.flush();
      return;
    }
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    // whatever the hardware still holds is lifted
    const held = this.hw.buttons || this.hw.keys;
    this.hw = { buttons: 0, keys: 0 };
    if (held) this.masks();
  }

  events(list) {
    if (!this.attached || !this.post || !Array.isArray(list) || list.length > MAX_EVENTS) return;
    let masks = false;
    for (const e of list) {
      if (!valid(e)) continue;
      if (e.kind === "button" || e.kind === "key") {
        const kind = e.kind === "button" ? "buttons" : "keys";
        const bit = 1 << (e.kind === "button" ? BUTTONS.indexOf(e.name) : e.index);
        this.hw[kind] = (e.down ? this.hw[kind] | bit : this.hw[kind] & ~bit) >>> 0;
        masks = true;
      } else if (e.kind === "encoder") {
        if (masks) this.masks();                      // (a press before a turn goes in first)
        masks = false;
        this.post({ type: "enc", role: ENCODERS.indexOf(e.name), n: e.steps });
      } else {
        this.post({ type: "master", value: e.value });
      }
    }
    if (masks) this.masks();
  }

  masks() {
    if (!this.post) return;
    this.post({ type: "buttons", mask: this.hw.buttons >>> 0, direct: true });
    this.post({ type: "keys", mask: this.hw.keys >>> 0, direct: true });
  }

  flush() {
    if (!this.attached || this.timer !== null || !(this.dirty.screen || this.dirty.leds)) return;
    const wait = this.sentAt + FRAME_MS - this.now();
    if (wait > 0) {
      this.timer = this.setTimer(() => { this.timer = null; this.flush(); }, wait);
      return;
    }
    const msg = { type: "panel-frame" }, transfer = [];
    if (this.dirty.screen && this.fb) {
      const copy = screenRgb565(this.fb);              // (a copy: the page keeps painting its own)
      msg.screen = copy.buffer;
      transfer.push(copy.buffer);
    }
    if (this.dirty.leds && this.leds) msg.leds = this.leds;
    this.dirty = { screen: false, leds: false };
    this.sentAt = this.now();
    if (msg.screen || msg.leds) this.send(msg, transfer);
  }
}
