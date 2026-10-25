// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// worklet-tutti.js's hardware FM-1 presses (protocol 12) against a fake device: presses at once, a lift waits only
// until its kind's last change is PANEL_HOLD_MS old (the main loop reads levels every 15 ms), in order.
// node web/plugin/fm1_panel_worklet_test.mjs
import assert from "node:assert/strict";

let Sloop = null;
globalThis.AudioWorkletProcessor = class { constructor() { this.port = { postMessage() {}, onmessage: null }; } };
globalThis.registerProcessor = (_name, cls) => { Sloop = cls; };
globalThis.currentFrame = 0;
globalThis.sampleRate = 44100;
await import("./worklet-tutti.js");
const w = new Sloop();

let now = 1000;
const applied = [];
w.ex = {
  dev_now_ms: () => now,
  dev_buttons: (m) => applied.push(["buttons", m, now]),
  dev_keys: (m) => applied.push(["keys", m, now]),
};
const send = (type, mask) => w.onMessage({ type, mask, direct: true });

// a press goes in at once
send("keys", 1);
assert.deepEqual(applied, [["keys", 1, 1000]]);
// a quick lift (5 ms later) waits until the press is PANEL_HOLD_MS (20 ms) old
now = 1005;
send("keys", 0);
assert.equal(applied.length, 1);
// a press of another kind behind it waits too (in order)
send("buttons", 1 << 3);
assert.equal(applied.length, 1);
now = 1019;
w.panel();
assert.equal(applied.length, 1);
now = 1020;
w.panel();
assert.deepEqual(applied.slice(1), [["keys", 0, 1020], ["buttons", 1 << 3, 1020]]);
// playing: each new press at once, a lift after a held note at once
now = 1100;
send("keys", 1 << 4);
now = 1101;
send("keys", (1 << 4) | (1 << 6));
now = 1300;
send("keys", 1 << 6);
assert.deepEqual(applied.slice(3), [["keys", 1 << 4, 1100], ["keys", (1 << 4) | (1 << 6), 1101], ["keys", 1 << 6, 1300]]);
console.log("fm1_panel_worklet_test: ok");
