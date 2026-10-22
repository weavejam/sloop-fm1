// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 weavejam
// 44.1 kHz -> 48 kHz for the renders a host asks at 48 kHz (the firmware runs at 44.1 kHz only): a polyphase
// windowed-sinc interpolator at the exact ratio 160 / 147. Each output frame m sits at input position m * 147 / 160
// (no delay: the filter is centred on it, the input around it is there before it is computed), one of 160 phases of a
// Kaiser-windowed sinc of 2 * HALF taps, its taps summed to 1 (DC exact). HALF 96 (192 taps), cut-off 0.95 of the
// input's Nyquist (20.9 kHz), beta 9.5: the passband flat to ~20 kHz, the images under -90 dB. Double precision
// throughout, the same order of operations each time: the same input gives the same output (deterministic).
export const L = 160, M = 147, HALF = 96;
const CUTOFF = 0.95, BETA = 9.5;

function bessel0(x) {                                  // the modified Bessel function I0, its series
  let s = 1, t = 1;
  for (let k = 1; k < 64; k++) {
    t *= (x / (2 * k)) ** 2;
    s += t;
    if (t < s * 1e-17) break;
  }
  return s;
}

let TABLE = null;                                      // [phase][tap], tap j = input i - HALF + 1 + j
function table() {
  if (TABLE) return TABLE;
  const t = new Float64Array(L * 2 * HALF), i0 = bessel0(BETA);
  for (let p = 0; p < L; p++) {
    let sum = 0;
    for (let j = 0; j < 2 * HALF; j++) {
      const x = j - HALF + 1 - p / L;                  // the tap's distance from the output's position
      const u = x / HALF, w = Math.abs(u) < 1 ? bessel0(BETA * Math.sqrt(1 - u * u)) / i0 : 0;
      const a = Math.PI * CUTOFF * x, s = x === 0 ? CUTOFF : CUTOFF * Math.sin(a) / a;
      t[p * 2 * HALF + j] = s * w;
      sum += s * w;
    }
    for (let j = 0; j < 2 * HALF; j++) t[p * 2 * HALF + j] /= sum;
  }
  return (TABLE = t);
}

// A stereo stream: push the input (frames from input 0, silence before it), take output frames from output frame
// `start` on, as far as the input pushed allows.
export class Resampler {
  constructor(start = 0) {
    this.h = table();
    this.next = start;                                 // the next output frame
    this.base = 0;                                     // the input frame buf[0] holds
    this.n = 0;                                        // input frames held
    this.l = new Float64Array(16384);
    this.r = new Float64Array(16384);
  }
  // input frames the output frames up to `end` (exclusive) need, in all
  static inputFor(end) { return end > 0 ? Math.floor(((end - 1) * M) / L) + HALF + 1 : 0; }
  push(l, r) {
    const need = this.n + l.length;
    if (need > this.l.length) {
      const keep = Math.max(0, Math.floor((this.next * M) / L) - HALF + 1 - this.base);   // what the next frame reads
      if (keep > 0) {                                  // drop what no output frame reads any more
        this.l.copyWithin(0, keep, this.n);
        this.r.copyWithin(0, keep, this.n);
        this.n -= keep;
        this.base += keep;
      }
      if (this.n + l.length > this.l.length) {
        const size = 2 ** Math.ceil(Math.log2(this.n + l.length));
        const nl = new Float64Array(size), nr = new Float64Array(size);
        nl.set(this.l.subarray(0, this.n));
        nr.set(this.r.subarray(0, this.n));
        this.l = nl;
        this.r = nr;
      }
    }
    for (let i = 0; i < l.length; i++) {
      this.l[this.n + i] = l[i];
      this.r[this.n + i] = r[i];
    }
    this.n += l.length;
  }
  // up to `max` output frames into outL / outR (from index `at`): how many
  take(outL, outR, at, max) {
    const h = this.h, have = this.base + this.n;
    let k = 0;
    for (; k < max; k++) {
      const m = this.next, num = m * M, i = Math.floor(num / L), p = num - i * L;
      if (i + HALF >= have) break;                     // its last tap is not there yet
      const off = p * 2 * HALF, first = i - HALF + 1, j0 = first < 0 ? -first : 0;   // (silence before input 0)
      const bl = this.l, br = this.r, b0 = first - this.base;
      let sl = 0, sr = 0;
      for (let j = j0; j < 2 * HALF; j++) {
        const c = h[off + j];
        sl += bl[b0 + j] * c;
        sr += br[b0 + j] * c;
      }
      outL[at + k] = sl;
      outR[at + k] = sr;
      this.next++;
    }
    return k;
  }
}
