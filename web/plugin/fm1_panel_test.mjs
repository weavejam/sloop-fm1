// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// fm1-panel.js (a hardware FM-1 through tuttidaw, protocol 12) against a fake worklet node: node web/plugin/fm1_panel_test.mjs
import assert from "node:assert/strict";
import { PanelBridge, panelLeds, BUTTONS } from "./fm1-panel.js";

let now = 0;
const timers = [];
const sent = [];
const posted = [];
const bridge = new PanelBridge((m, transfer) => sent.push({ m, transfer }), {
  now: () => now,
  setTimer: (fn, ms) => { timers.push({ fn, at: now + ms }); return timers.length; },
  clearTimer: () => { timers.length = 0; },
});
const node = { port: { postMessage: (m) => posted.push(m) } };
bridge.node(node);
const run = () => { while (timers.length) { const t = timers.shift(); now = Math.max(now, t.at); t.fn(); } };

// nothing goes to the host until attached; events before it are ignored
bridge.frame({ type: "frame", fb: new Uint16Array(240 * 240).fill(7), leds: [1 << 6, 1, 0, 2, 0, 0, 0, 0] });
bridge.events([{ kind: "key", index: 0, down: true }]);
assert.equal(sent.length, 0);
assert.equal(posted.length, 0);

// attach: the first frame carries the screen and the LEDs
bridge.attach(true);
assert.equal(sent.length, 1);
assert.equal(sent[0].m.type, "panel-frame");
assert.equal(new Uint16Array(sent[0].m.screen)[0], 7);
assert.equal(sent[0].m.screen.byteLength, 240 * 240 * 2);
assert.deepEqual(sent[0].transfer, [sent[0].m.screen]);
assert.deepEqual(sent[0].m.leds, { buttons: { lit: 1 << 6, dim: 0 }, keys: { lit: 1, dim: 2 }, playGreen: false });

// the page's own masks and the hardware's combine; neither lifts the other's press
node.port.postMessage({ type: "buttons", mask: 1 << 2 });          // the page holds ENV
bridge.events([{ kind: "button", name: "scl", down: true }, { kind: "key", index: 3, down: true }]);
assert.deepEqual(posted.slice(-2), [{ type: "buttons", mask: (1 << 2) | (1 << 1) }, { type: "keys", mask: 1 << 3 }]);
node.port.postMessage({ type: "buttons", mask: 0 });               // the page lets ENV go: SCL still held
assert.deepEqual(posted.at(-1), { type: "buttons", mask: 1 << 1 });

// encoders by role, MASTER as it is; invalid events dropped
posted.length = 0;
bridge.events([
  { kind: "encoder", name: "knob2", steps: -3 },
  { kind: "master", value: 900 },
  { kind: "encoder", name: "knob9", steps: 1 },
  { kind: "key", index: 27, down: true },
  { kind: "master", value: 2000 },
]);
assert.deepEqual(posted, [{ type: "enc", role: 4, n: -3 }, { type: "master", value: 900 }]);

// frames at most 30 a second: the latest goes when the time comes
sent.length = 0;
bridge.frame({ type: "frame", fb: new Uint16Array(240 * 240).fill(1) });
bridge.frame({ type: "frame", fb: new Uint16Array(240 * 240).fill(2) });
assert.equal(sent.length, 0);
run();
assert.equal(sent.length, 1);
assert.equal(new Uint16Array(sent[0].m.screen)[0], 2);
assert.equal(sent[0].m.leds, undefined);

// detaching lifts what the hardware holds (the page's own stay)
posted.length = 0;
node.port.postMessage({ type: "keys", mask: 1 << 9 });
bridge.attach(false);
assert.deepEqual(posted.slice(-2), [{ type: "buttons", mask: 0 }, { type: "keys", mask: 1 << 9 }]);
sent.length = 0;
bridge.frame({ type: "frame", fb: new Uint16Array(240 * 240) });
run();
assert.equal(sent.length, 0);

// LED mapping: lit wins over dim; breath and mid glow; PLAY's green
assert.deepEqual(panelLeds([(1 << 14) | 1, 0, 1 | 2, 0, 0, 4, 8, 16]), {
  buttons: { lit: 1, dim: 2 | 4 }, keys: { lit: 0, dim: 8 | 16 }, playGreen: true,
});
assert.equal(BUTTONS.length, 14);
console.log("fm1_panel_test: ok");
