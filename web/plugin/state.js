// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// The plugin's state (tutti-plugin/0 `state`, opaque to the host): SLOOP's flash storage sectors (sloop_plugin.c's NOR
// image: the settings with the song order, the SYN kits, the MIDI part and the theme; the sections A..D; the working
// project, written just before as the autosave (sloop_plugin.c tutti_snapshot); the user preset banks; the FM6 patch
// bank; the user sample slots USR1..USR4), only those that hold something, and the plugin's own settings (what a
// render plays). Version 1, little-endian:
//   "SLPT"  u32 version (1)  u32 metaLength  meta (UTF-8 JSON)  u32 count  then count x { u32 offset, 4096 bytes }
//   (offsets ascending)
// meta: { play: "auto" | "song" | "pattern" | "A" | "B" | "C" | "D" } (renderer.js PLAY). At most 104 sectors
// (~ 420 KiB), far under the host's 8 MiB.

export const STATE_VERSION = 1;
export const STATE_READS = [1, 1];
const MAGIC = 0x54504c53;                              // "SLPT"
const SECTOR = 4096;
// the flash areas storage.c writes (sloop_plugin.c FL_STORE_OK, hal/fm1_flash.h): [start, end)
export const STORE_AREAS = [
  [0x97000, 0xE0000],                                  // the projects (sections A..D), the autosave's copy A, USR1..USR3,
                                                       // the user preset banks
  [0xE5000, 0xE7000],                                  // the FM6 patch bank
  [0xE7000, 0xFB000],                                  // the user sample slot USR4
  [0xFC000, 0xFF000],                                  // the settings (A / B), the autosave's copy B
];
export const PLAYS = ["auto", "song", "pattern", "A", "B", "C", "D"];
export const DEFAULT_META = Object.freeze({ play: "auto" });

export class StateError extends Error {
  constructor(message) { super(message); this.name = "StateError"; this.code = "state-incompatible"; }
}

// the NOR image's storage sectors that hold something -> {offset: Uint8Array(4096)} (copies)
export function storeSectors(nor) {
  const out = {};
  for (const [a, e] of STORE_AREAS)
    for (let off = a; off < e; off += SECTOR) {
      const s = nor.subarray(off, off + SECTOR);
      if (s.some((b) => b !== 0xFF)) out[off] = s.slice();
    }
  return out;
}
// the sectors into an erased NOR image
export function restoreSectors(nor, sectors) {
  for (const off of Object.keys(sectors)) nor.set(sectors[off], +off);
}

export function cleanMeta(m) {
  return { play: m && PLAYS.includes(m.play) ? m.play : DEFAULT_META.play };
}

// {sectors, meta} -> ArrayBuffer
export function packState({ sectors, meta = DEFAULT_META }) {
  const offs = Object.keys(sectors).map(Number).sort((a, b) => a - b);
  const mj = new TextEncoder().encode(JSON.stringify(cleanMeta(meta)));
  const head = 12 + mj.length + 4;
  const buf = new ArrayBuffer(head + offs.length * (4 + SECTOR)), dv = new DataView(buf), u8 = new Uint8Array(buf);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, STATE_VERSION, true);
  dv.setUint32(8, mj.length, true);
  u8.set(mj, 12);
  dv.setUint32(12 + mj.length, offs.length, true);
  offs.forEach((off, i) => {
    const p = head + i * (4 + SECTOR);
    dv.setUint32(p, off, true);
    u8.set(sectors[off], p + 4);
  });
  return buf;
}

// -> {sectors: {offset: Uint8Array(4096)}, meta} (copies: the input is never changed); StateError when it is not one
export function unpackState(buf, version = STATE_VERSION) {
  if (version < STATE_READS[0] || version > STATE_READS[1]) throw new StateError(`state version ${version} not read by this plugin`);
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 16) throw new StateError("not a SLOOP state");
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  if (dv.getUint32(0, true) !== MAGIC) throw new StateError("not a SLOOP state");
  if (dv.getUint32(4, true) !== version) throw new StateError("state version differs from its header");
  const ml = dv.getUint32(8, true);
  if (ml > 4096 || 16 + ml > buf.byteLength) throw new StateError("state meta truncated");
  let meta;
  try { meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(u8.subarray(12, 12 + ml))); }
  catch { throw new StateError("state meta is not JSON"); }
  const head = 12 + ml + 4, n = dv.getUint32(12 + ml, true);
  if (buf.byteLength !== head + n * (4 + SECTOR)) throw new StateError("state truncated or padded");
  const out = {};
  let last = -1;
  for (let i = 0; i < n; i++) {
    const p = head + i * (4 + SECTOR), off = dv.getUint32(p, true);
    if (off <= last || off % SECTOR || !STORE_AREAS.some(([a, e]) => off >= a && off + SECTOR <= e))
      throw new StateError(`state sector at ${off} not a storage sector`);
    out[off] = u8.slice(p + 4, p + 4 + SECTOR);
    last = off;
  }
  return { sectors: out, meta: cleanMeta(meta) };
}

// the bytes a state is: for tests and the page (two states with the same music and settings are the same bytes)
export function stateEquals(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
