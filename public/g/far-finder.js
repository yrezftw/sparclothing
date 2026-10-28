// spår gallery: finds the owner's own garment codes in a photo when they are too small or blurry to
// read the normal way (a Web Worker, started by app.js). It knows what each of the owner's codes looks
// like, so instead of reading the squares it checks whether they match one of those codes:
//   1. spots that could be a code's corner mark (box sums, at sizes from 1.3 to 3.2 pixels per square)
//   2. a closer look at each spot: its middle, turn and how much it looks like a corner mark
//   3. groups of three marks placed like a code's, with a light margin around them
//   4. for the best few groups: the code's exact outline, then its squares compared with each of the
//      owner's codes and with 100 wrong codes that look alike; a match must stand far above all of them
// Built by tools/far-finder/build-far.py in the project's gallery folder, where its tests are.
"use strict";
importScripts("/g/qrcode-lib.js"); // the QR generator's own code maker, to know each code's squares

// Module patterns of garment codes, made exactly like the QR generator makes them.
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
// how garment codes are made: the QR generator's settings, and the largest logo hole it makes
let FORMAT = { base: 'https://sparclothing.se/g/', ecl: 'H', mode: 'Byte', logo: 0.38 };
function matrix(text) {
  const qr = qrcode(0, FORMAT.ecl); qr.addData(text, FORMAT.mode); qr.make();
  const n = qr.getModuleCount(), m = new Int8Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) m[r * n + c] = qr.isDark(r, c) ? 1 : -1;
  return { n, m };
}
const garment = id => matrix(FORMAT.base + id);
// kinds: 0 data, 1 fixed (finders, separators, timing, alignment, dark module), 2 format, 3 logo (largest hole)
function kinds(n) {
  const k = new Uint8Array(n * n), set = (r, c, v) => { if (r >= 0 && r < n && c >= 0 && c < n) k[r * n + c] = v; };
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) set(r0 + r, c0 + c, 1);
  for (let i = 8; i < n - 8; i++) { set(6, i, 1); set(i, 6, 1); }
  const ver = (n - 17) / 4;
  if (ver >= 2) { const p = n - 7; for (let r = p - 2; r <= p + 2; r++) for (let c = p - 2; c <= p + 2; c++) set(r, c, 1); } // one alignment pattern up to version 6
  set(n - 8, 8, 1);
  for (let i = 0; i <= 8; i++) { if (k[8 * n + i] !== 1) set(8, i, 2); if (k[i * n + 8] !== 1) set(i, 8, 2); }
  for (let i = n - 8; i < n; i++) set(8, i, 2);
  for (let i = n - 7; i < n; i++) set(i, 8, 2);
  // largest logo hole the generator makes
  if (FORMAT.logo) {
    const w0 = Math.round(n * FORMAT.logo), w = w0 % 2 ? w0 : w0 + 1, h0 = Math.round(w * 565 / 778) + 1, h = h0 % 2 ? h0 : h0 + 1;
    const r0 = (n - h) / 2, c0 = (n - w) / 2;
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) k[r * n + c] = 3;
  }
  return k;
}
// Which codeword (index in the final sequence) and bit each module carries; -1 for fixed parts and spare bits.
function placement(n) {
  const K = kinds(n), fixed = i => K[i] === 1 || K[i] === 2, cw = new Int16Array(n * n).fill(-1);
  let bit = 0, up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let t = 0; t < n; t++) {
      const row = up ? n - 1 - t : t;
      for (const c of [col, col - 1]) { const i = row * n + c; if (!fixed(i) || K[i] === 3) { if (K[i] === 3 || !fixed(i)) { cw[i] = bit++; } } }
    }
    up = !up;
  }
  return { bitOf: cw, bits: bit };
}
// random IDs with digits and letters in the same places as `like`
function lookalikeIds(like, count, seed = 11) {
  const DIG = '23456789', LET = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  while (out.length < count) {
    const id = [...like].map(ch => { const set = /[0-9]/.test(ch) ? DIG : LET; return set[Math.floor(rnd() * set.length)]; }).join('');
    if (id !== like) out.push(id);
  }
  return out;
}
// QR mask patterns, numbered as in the QR generator: true where a data square is flipped (i row, j column)
const MASKS = [(i, j) => (i + j) % 2 === 0, i => i % 2 === 0, (i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
  (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
  (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i * j) % 3 + (i + j) % 2) % 2 === 0];
// which mask a code uses, read from its format squares in column 8
function maskOf(mat, n) {
  let bits = 0;
  for (let i = 0; i < 15; i++) { const r = i < 6 ? i : i < 8 ? i + 1 : n - 15 + i; if (mat[r * n + 8] > 0) bits |= 1 << i; }
  return ((bits ^ 0x5412) >> 10) & 7;
}
// A code's squares as they would be with another code's mask (the QR generator picks the mask that
// suits each code best, so look-alike IDs often get another one).
function withMaskOf(mat, like, n) {
  const K = kinds(n), a = MASKS[maskOf(mat, n)], b = MASKS[maskOf(like, n)], out = Int8Array.from(mat);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    const i = r * n + c;
    if (K[i] === 2) out[i] = like[i];
    else if ((K[i] === 0 || K[i] === 3) && a(r, c) !== b(r, c)) out[i] = -out[i];
  }
  return out;
}

// Stage 1 (faster): spots that could be a code's corner mark, from box sums.
function integral(g, w, h) { // Uint32 is exact up to 16.8 million pixels of 255
  const W = w + 1, I = new Uint32Array(W * (h + 1));
  for (let y = 0; y < h; y++) { let row = 0; const o = (y + 1) * W, p = y * W, q = y * w; for (let x = 0; x < w; x++) { row += g[q + x]; I[o + x + 1] = I[p + x + 1] + row; } }
  return I;
}
function spots(g, w, h, I, scales, opts = {}) {
  const W = w + 1, out = [], T = opts.T ?? 12;
  for (const m of scales) {
    const stride = m < 2 ? 2 : 3;
    const r3 = Math.max(1, Math.round(1.5 * m)), r5 = Math.max(r3 + 1, Math.round(2.5 * m)), r7 = Math.max(r5 + 1, Math.round(3.5 * m)), r9 = Math.max(r7 + 1, Math.round(4.5 * m));
    const i3 = 1 / (2 * r3) ** 2, i5 = 1 / ((2 * r5) ** 2 - (2 * r3) ** 2), i7 = 1 / ((2 * r7) ** 2 - (2 * r5) ** 2), i9 = 1 / ((2 * r9) ** 2 - (2 * r7) ** 2);
    const sw = Math.floor((w - 2 * r9) / stride), sh = Math.floor((h - 2 * r9) / stride), S = new Float32Array(sw * sh);
    // offsets of the box corners from the centre index
    const o3a = r3 * W + r3, o3b = -r3 * W + r3, o3c = r3 * W - r3, o3d = -r3 * W - r3;
    const o5a = r5 * W + r5, o5b = -r5 * W + r5, o5c = r5 * W - r5, o5d = -r5 * W - r5;
    const o7a = r7 * W + r7, o7b = -r7 * W + r7, o7c = r7 * W - r7, o7d = -r7 * W - r7;
    const o9a = r9 * W + r9, o9b = -r9 * W + r9, o9c = r9 * W - r9, o9d = -r9 * W - r9;
    for (let j = 0; j < sh; j++) {
      const y = r9 + j * stride; let c = y * W + r9;
      for (let i = 0; i < sw; i++, c += stride) {
        const b3 = I[c + o3a] - I[c + o3b] - I[c + o3c] + I[c + o3d];
        const b7 = I[c + o7a] - I[c + o7b] - I[c + o7c] + I[c + o7d];
        const b9 = I[c + o9a] - I[c + o9b] - I[c + o9c] + I[c + o9d];
        const D0 = b3 * i3, L3 = (b9 - b7) * i9, e = L3 - D0;
        if (e < T && e > -T) continue; // neither a dark nor a light mark here
        const b5 = I[c + o5a] - I[c + o5b] - I[c + o5c] + I[c + o5d];
        const L1 = (b5 - b3) * i5, D2 = (b7 - b5) * i7;
        if (e > 0) { const v = Math.min(e, L3 - D2, L1 - D0); if (v >= T) S[j * sw + i] = v; }
        else { const v = Math.min(-e, D2 - L3, D0 - L1); if (v >= T) S[j * sw + i] = -v; }
      }
    }
    const R = Math.max(1, Math.round(1.5 * m / stride));
    for (let j = R; j < sh - R; j++) for (let i = R; i < sw - R; i++) {
      const v = S[j * sw + i]; if (v === 0) continue;
      let best = true;
      for (let dj = -R; dj <= R && best; dj++) for (let di = -R; di <= R; di++) {
        if (!di && !dj) continue; const u = S[(j + dj) * sw + i + di];
        if (v > 0 ? u > v || (u === v && (dj < 0 || (dj === 0 && di < 0))) : u < v || (u === v && (dj < 0 || (dj === 0 && di < 0)))) { best = false; break; }
      }
      if (best) out.push({ x: r9 + i * stride, y: r9 + j * stride, m, s: Math.abs(v), pol: v > 0 ? 1 : -1 });
    }
  }
  return out;
}

// Stage 2: look closer at each spot: find its exact middle and turn, then compare it with a
// blurred picture of a corner mark (normalised cross-correlation, -1..1).
const bil = (g, w, h, x, y) => { // pixel i covers [i, i+1); returns NaN outside
  x -= 0.5; y -= 0.5;
  if (x < 0 || y < 0 || x >= w - 1 || y >= h - 1) return NaN;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * w + x0;
  return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
};
// expected darkness (+1 dark .. -1 light) of a corner mark plus its light border, at module offsets (u, v), blurred by s modules
function markValue(u, v) { const r = Math.max(Math.abs(u), Math.abs(v)); return r <= 1.5 ? 1 : r <= 2.5 ? -1 : r <= 3.5 ? 1 : -1; }
const blurCache = new Map();
function markTemplate(s) { // 17x17 samples at half-module steps, blurred with gaussian s (modules), by supersampling
  const key = Math.round(s * 20); if (blurCache.has(key)) return blurCache.get(key);
  const sg = Math.max(0.05, key / 20), out = new Float32Array(289), K = 5, step = 0.125;
  for (let j = 0; j < 17; j++) for (let i = 0; i < 17; i++) {
    const u0 = (i - 8) / 2, v0 = (j - 8) / 2; let sum = 0, wsum = 0;
    for (let dv = -K * sg; dv <= K * sg; dv += step) for (let du = -K * sg; du <= K * sg; du += step) {
      const wt = Math.exp(-(du * du + dv * dv) / (2 * sg * sg)), u = u0 + du, v = v0 + dv;
      sum += wt * (Math.max(Math.abs(u), Math.abs(v)) > 4.5 ? -1 : markValue(u, v)); wsum += wt;
    }
    out[j * 17 + i] = sum / wsum;
  }
  // normalise to zero mean, unit norm
  let mean = 0; for (const v of out) mean += v; mean /= 289; let nn = 0; for (let k = 0; k < 289; k++) { out[k] -= mean; nn += out[k] ** 2; }
  nn = Math.sqrt(nn); for (let k = 0; k < 289; k++) out[k] /= nn;
  blurCache.set(key, out); return out;
}
// darkness-weighted centre, twice
function centre(g, w, h, x, y, m, pol) {
  for (let it = 0; it < 2; it++) {
    const R = 2.5 * m; let ref = 0, n = 0;
    for (let k = 0; k < 16; k++) { const a = k * Math.PI / 8, v = bil(g, w, h, x + Math.cos(a) * 4.6 * m, y + Math.sin(a) * 4.6 * m); if (!Number.isNaN(v)) { ref += v; n++; } }
    if (!n) return null; ref /= n;
    let sx = 0, sy = 0, sw = 0;
    const x0 = Math.floor(x - R), x1 = Math.ceil(x + R), y0 = Math.floor(y - R), y1 = Math.ceil(y + R);
    if (x0 < 0 || y0 < 0 || x1 >= w || y1 >= h) return null;
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const d = pol * (ref - g[yy * w + xx]); if (d <= 0) continue;
      const px = xx + 0.5, py = yy + 0.5, f = Math.max(0, 1 - Math.max(Math.abs(px - x), Math.abs(py - y)) / R);
      sx += d * f * px; sy += d * f * py; sw += d * f;
    }
    if (sw <= 0) return null; x = sx / sw; y = sy / sw;
  }
  return { x, y };
}
const MARK_SIGN = (() => { const o = new Int8Array(289); let k = 0; for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++, k++) { const r = Math.max(Math.abs(i), Math.abs(j)) / 2; o[k] = r < 1.25 || (r > 2.75 && r < 3.25) ? 1 : (r > 1.75 && r < 2.25) || r > 3.75 ? -1 : 0; } return o; })();
let lastLevels = null; // grey levels of the dark and light parts of the last mark looked at
function ncc(g, w, h, x, y, m, th, pol, tpl) {
  const c = Math.cos(th) * m / 2, s = Math.sin(th) * m / 2, vals = new Float32Array(289); let mean = 0, k = 0;
  for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++, k++) {
    const v = bil(g, w, h, x + i * c - j * s, y + i * s + j * c); if (Number.isNaN(v)) return -1;
    vals[k] = -pol * v; mean += vals[k];
  }
  mean /= 289; let dot = 0, nn = 0, ds = 0, dn = 0, ls = 0, ln = 0;
  for (k = 0; k < 289; k++) { const d = vals[k] - mean; dot += d * tpl[k]; nn += d * d; if (MARK_SIGN[k] > 0) { ds += vals[k]; dn++; } else if (MARK_SIGN[k] < 0) { ls += vals[k]; ln++; } }
  lastLevels = [-pol * ds / dn, -pol * ls / ln];
  return nn > 0 ? dot / Math.sqrt(nn) : -1;
}
// ---- faster variant: a quick look at the 81 square centres first ----
const quickCache = new Map();
function quickTemplate(s) {
  const key = Math.round(s * 20); if (quickCache.has(key)) return quickCache.get(key);
  const full = markTemplate(s), q = new Float32Array(81); let k = 0, mean = 0;
  for (let j = 0; j < 17; j += 2) for (let i = 0; i < 17; i += 2) { q[k] = full[j * 17 + i]; mean += q[k++]; }
  mean /= 81; let nn = 0; for (k = 0; k < 81; k++) { q[k] -= mean; nn += q[k] * q[k]; } nn = Math.sqrt(nn); for (k = 0; k < 81; k++) q[k] /= nn;
  quickCache.set(key, q); return q;
}
function quickNcc(g, w, h, x, y, m, th, pol, tpl) {
  const c = Math.cos(th) * m, s = Math.sin(th) * m, vals = new Float32Array(81); let mean = 0, k = 0;
  for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++, k++) {
    const v = bil(g, w, h, x + i * c - j * s, y + i * s + j * c); if (Number.isNaN(v)) return -1;
    vals[k] = -pol * v; mean += vals[k];
  }
  mean /= 81; let dot = 0, nn = 0;
  for (k = 0; k < 81; k++) { const d = vals[k] - mean; dot += d * tpl[k]; nn += d * d; }
  return nn > 0 ? dot / Math.sqrt(nn) : -1;
}
function turnFast(g, w, h, x, y, m) {
  const R = Math.ceil(4 * m), st = m < 2 ? 1 : 2, cx = Math.round(x), cy = Math.round(y); let re = 0, im = 0;
  if (cx - R - 1 < 0 || cy - R - 1 < 0 || cx + R + 1 >= w || cy + R + 1 >= h) return 0;
  for (let yy = cy - R; yy <= cy + R; yy += st) for (let xx = cx - R; xx <= cx + R; xx += st) {
    const i = yy * w + xx, gx = g[i + 1] - g[i - 1], gy = g[i + w] - g[i - w], q = gx * gx + gy * gy; if (q < 1) continue;
    const c2 = (gx * gx - gy * gy), s2 = 2 * gx * gy;
    re += (c2 * c2 - s2 * s2) / q; im += 2 * c2 * s2 / q;
  }
  return Math.atan2(im, re) / 4;
}
function examineFast(g, w, h, spot, blurPx = 1.0, quickMin = 0.45) {
  const c = centre(g, w, h, spot.x, spot.y, spot.m, spot.pol); if (!c) return null;
  const th = turnFast(g, w, h, c.x, c.y, spot.m);
  const q = quickNcc(g, w, h, c.x, c.y, spot.m, th, spot.pol, quickTemplate(blurPx / spot.m));
  if (q < quickMin) return null;
  let best = { r: -1 };
  for (const f of [0.88, 1, 1.13]) {
    const m = spot.m * f, r = ncc(g, w, h, c.x, c.y, m, th, spot.pol, markTemplate(blurPx / m));
    if (r > best.r) best = { r, m, lv: lastLevels };
  }
  return { x: c.x, y: c.y, th, m: best.m, r: best.r, q, pol: spot.pol, s: spot.s, dark: best.lv && best.lv[0], light: best.lv && best.lv[1] };
}
// A mark seen from the side is narrower one way: try stretched shapes and keep the best fit.
// Adds mu, mv (pixels per square along the mark's two sides) to the mark.
function stretch(g, w, h, e, blurPx = 1.0) {
  const c = Math.cos(e.th), s = Math.sin(e.th);
  let best = { r: e.r, mu: e.m, mv: e.m };
  for (const [ku, kv] of [[1, 1.25], [1, 1.55], [1, 1.9], [1.25, 1], [1.55, 1], [1.9, 1], [1.25, 1.25], [1.55, 1.55], [0.85, 0.85]]) {
    const mu = e.m * ku, mv = e.m * kv, r = markNcc(g, w, h, e.x, e.y, [mu * c, mu * s], [-mv * s, mv * c], e.pol, markTemplate(blurPx / Math.sqrt(mu * mv)));
    if (r > best.r) best = { r, mu, mv };
  }
  e.mu = best.mu; e.mv = best.mv; e.r2 = best.r; e.mBig = Math.max(best.mu, best.mv); e.mGeo = Math.sqrt(best.mu * best.mv);
  return e;
}

// Stage 3: groups of three corner marks placed like a QR code's (an L), checked as a whole:
// each mark again with the group's own shape, plus the two dotted lines between the marks.
// sample a mark with an affine basis ex, ey (pixel offset per module along the code's rows and columns)
function markNcc(g, w, h, x, y, ex, ey, pol, tpl) {
  const vals = new Float32Array(289); let mean = 0, k = 0;
  for (let j = -8; j <= 8; j++) for (let i = -8; i <= 8; i++, k++) {
    const u = i / 2, v = j / 2, val = bil(g, w, h, x + u * ex[0] + v * ey[0], y + u * ex[1] + v * ey[1]);
    if (Number.isNaN(val)) return -1;
    vals[k] = -pol * val; mean += vals[k];
  }
  mean /= 289; let dot = 0, nn = 0;
  for (k = 0; k < 289; k++) { const d = vals[k] - mean; dot += d * tpl[k]; nn += d * d; }
  return nn > 0 ? dot / Math.sqrt(nn) : -1;
}
// dotted line along row 6 from column 8 to N-9 (and column 6): correlation with alternating dark/light,
// against the light separator rows 7 next to it? simpler: alternate between module centres and compare
function timingScore(g, w, h, P, N, pol) {
  let dot = 0, nn = 0, mean = 0; const vals = [];
  for (let i = 8; i <= N - 9; i++) {
    for (const [u, v] of [[i + 0.5, 6.5], [6.5, i + 0.5]]) { const [x, y] = P(u, v), val = bil(g, w, h, x, y); if (Number.isNaN(val)) return -1; vals.push([-pol * val, i % 2 === 0 ? 1 : -1]); }
  }
  for (const [v] of vals) mean += v; mean /= vals.length;
  let tt = 0; for (const [v, t] of vals) { dot += (v - mean) * t; nn += (v - mean) ** 2; tt += t * t; }
  return nn > 0 ? dot / Math.sqrt(nn * tt) : -1;
}
const wrap90 = a => { a = ((a % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2); return a > Math.PI / 4 ? a - Math.PI / 2 : a; };
// share of samples just outside the code's edge that are light (nearer the light grey than the dark grey);
// a first round of 24 spread-out samples may hold at most 2 dark ones, then up to (1 - minOk) of all
function quietScore(g, w, h, P, N, pol, dark, light, minOk = 0) {
  const cut = dark + 0.35 * (light - dark), sgn = light > dark ? 1 : -1, total = (N + 2) * 8, maxBad = Math.floor((1 - minOk) * total);
  const at = (u, v) => { const [x, y] = P(u, v), val = bil(g, w, h, x, y); return Number.isNaN(val) ? false : sgn * (val - cut) > 0; };
  let bad = 0;
  for (let k = 0; k < 6; k++) {
    const t = (k + 0.5) * (N + 2) / 6 - 1;
    if (!at(t, -1.5)) bad++; if (!at(t, N + 1.5)) bad++; if (!at(-1.5, t)) bad++; if (!at(N + 1.5, t)) bad++;
    if (bad > 2) return 0;
  }
  let ok = 0, n = 0; bad = 0;
  for (let i = -1; i <= N; i++) for (const off of [-1.0, -1.75]) {
    for (const [u, v] of [[i + 0.5, off], [i + 0.5, N - off], [off, i + 0.5], [N - off, i + 0.5]]) {
      n++; if (at(u, v)) ok++; else if (++bad > maxBad) return 0;
    }
  }
  return ok / n;
}
// cands: marks {x, y, m, th, pol, r, mBig, mGeo, dark, light}. B must lie along one side direction of A's
// turn, C along the next one; the best few marks in each direction are tried.
function triplets(g, w, h, cands, N, opts = {}) {
  const span = N - 7, cell = 64, grid = new Map(), out = [], cone = opts.cone ?? 20 * Math.PI / 180, perSide = opts.perSide ?? 8;
  for (const c of cands) { const k = Math.floor(c.x / cell) + ',' + Math.floor(c.y / cell); (grid.get(k) || grid.set(k, []).get(k)).push(c); }
  const blurPx = opts.blurPx ?? 1.0, rMin = opts.rMin ?? 0.45, quietMin = opts.quietMin ?? 0.85;
  let tested = 0;
  for (const a of cands) {
    const dMin = opts.dMin ?? 0.5 * span, dMax = opts.dMax ?? 4.5 * span, sides = [[], [], [], []];
    for (let gy = Math.floor((a.y - dMax) / cell); gy <= Math.floor((a.y + dMax) / cell); gy++)
      for (let gx = Math.floor((a.x - dMax) / cell); gx <= Math.floor((a.x + dMax) / cell); gx++)
        for (const b of grid.get(gx + ',' + gy) || []) {
          if (b === a || b.pol !== a.pol) continue;
                    if (Math.abs(wrap90(b.th - a.th)) > cone) continue;
          const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy); if (d < dMin || d > dMax) continue;
          const rel = Math.atan2(dy, dx) - a.th, k = Math.round(rel / (Math.PI / 2));
          if (Math.abs(rel - k * Math.PI / 2) > cone) continue;
          sides[((k % 4) + 4) % 4].push(b);
        }
    for (const sd of sides) if (sd.length > perSide) { sd.sort((p, q) => (q.r2 ?? q.r) - (p.r2 ?? p.r)); sd.length = perSide; }
    for (let k = 0; k < 4; k++) for (const [s1, s2, mirrored] of [[sides[k], sides[(k + 1) % 4], false], [sides[(k + 1) % 4], sides[k], true]]) {
      if (!opts.mirrored && mirrored) continue;
      for (const b of s1) for (const c of s2) {
        const abx = b.x - a.x, aby = b.y - a.y, acx = c.x - a.x, acy = c.y - a.y, lab = Math.hypot(abx, aby), lac = Math.hypot(acx, acy);
        if (lab / lac < 0.45 || lab / lac > 2.2) continue;
        const ex = [abx / span, aby / span], ey = [acx / span, acy / span];
        const mm = Math.sqrt(Math.abs(ex[0] * ey[1] - ex[1] * ey[0])), sr = mm / Math.max(a.mGeo ?? a.m, b.mGeo ?? b.m, c.mGeo ?? c.m);
        if (mm < (opts.mMin ?? 1.0) || mm > (opts.mMax ?? 4.5)) continue;
        // same print, same light: the marks' dark and light greys should match
        const amp = Math.abs(a.light - a.dark), tol = (opts.levelTol ?? 0.7) * amp + 15;
        if (Math.abs(b.dark - a.dark) > tol || Math.abs(c.dark - a.dark) > tol || Math.abs(b.light - a.light) > tol || Math.abs(c.light - a.light) > tol) continue;
        const P = (u, v) => [a.x + (u - 3.5) * ex[0] + (v - 3.5) * ey[0], a.y + (u - 3.5) * ex[1] + (v - 3.5) * ey[1]];
        // the light margin around the code
        const q = quietScore(g, w, h, P, N, a.pol, (a.dark + b.dark + c.dark) / 3, (a.light + b.light + c.light) / 3, quietMin); if (q < quietMin) continue;
        tested++;
        const tpl = markTemplate(blurPx / mm);
        const ra = markNcc(g, w, h, a.x, a.y, ex, ey, a.pol, tpl); if (ra < rMin) continue;
        const rb = markNcc(g, w, h, b.x, b.y, ex, ey, a.pol, tpl); if (rb < rMin) continue;
        const rc = markNcc(g, w, h, c.x, c.y, ex, ey, a.pol, tpl); if (rc < rMin) continue;
        const tm = timingScore(g, w, h, P, N, a.pol);
        out.push({ a, b, c, ex, ey, ra, rb, rc, tm, q, s: Math.min(ra, rb, rc) + 0.5 * tm, mirrored });
      }
    }
  }
  out.sort((p, q) => q.s - p.s);
  out.tested = tested;
  return out;
}

// Stage 4: fit the code's outline exactly (homography), then compare the squares with each known code.
const SUB = 4, PAD = 3; // fine grid: 4x4 cells per module, 3 modules of light margin around the code
function homography(src, dst) {
  const A = [], B = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i], [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); B.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); B.push(y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]]; [B[c], B[p]] = [B[p], B[c]];
    if (Math.abs(A[c][c]) < 1e-12) return null;
    for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; B[r] -= f * B[c]; }
  }
  return B.map((b, i) => b / A[i][i]);
}
const apply = (H, u, v) => { const z = H[6] * u + H[7] * v + 1; return [(H[0] * u + H[1] * v + H[2]) / z, (H[3] * u + H[4] * v + H[5]) / z]; };
// fine grid of a module map (values +1 dark, -1 light, 0 unknown), blurred by s modules
function blurGrid(n, value, s) {
  const G = (n + 2 * PAD) * SUB, a = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
    const c = Math.floor(i / SUB) - PAD, r = Math.floor(j / SUB) - PAD;
    a[j * G + i] = r < 0 || c < 0 || r >= n || c >= n ? -1 : value(r, c);
  }
  const sg = Math.max(0.05, s) * SUB, R = Math.ceil(3 * sg), k = []; let ks = 0;
  for (let d = -R; d <= R; d++) { const v = Math.exp(-d * d / (2 * sg * sg)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(G * G), out = new Float32Array(G * G);
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { let v = 0; for (let d = -R; d <= R; d++) { const ii = Math.min(G - 1, Math.max(0, i + d)); v += k[d + R] * a[j * G + ii]; } tmp[j * G + i] = v; }
  for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) { let v = 0; for (let d = -R; d <= R; d++) { const jj = Math.min(G - 1, Math.max(0, j + d)); v += k[d + R] * tmp[jj * G + i]; } out[j * G + i] = v; }
  return { G, a: out, n };
}
const gridAt = (B, u, v) => { // u, v in modules (0..n), bilinear on cell centres
  const x = (u + PAD) * SUB - 0.5, y = (v + PAD) * SUB - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0, G = B.G;
  if (x0 < 0 || y0 < 0 || x0 >= G - 1 || y0 >= G - 1) return -1;
  const i = y0 * G + x0;
  return (B.a[i] * (1 - fx) + B.a[i + 1] * fx) * (1 - fy) + (B.a[i + G] * (1 - fx) + B.a[i + G + 1] * fx) * fy;
};
// the parts every code shares (finders, separators, timing, alignment, light margin), as sample points
const genericCache = new Map();
function generic(ref, n, s) {
  const key = n + ':' + Math.round(s * 20); if (genericCache.has(key)) return genericCache.get(key);
  const K = kinds(n), B = blurGrid(n, (r, c) => (K[r * n + c] === 1 ? ref[r * n + c] : 0), s);
  const pts = [];
  for (let r = -2; r < n + 2; r++) for (let c = -2; c < n + 2; c++) {
    const inside = r >= 0 && c >= 0 && r < n && c < n; if (inside && K[r * n + c] !== 1) continue;
    for (const [du, dv] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) pts.push(c + du, r + dv, gridAt(B, c + du, r + dv));
  }
  const P = Float32Array.from(pts); let mean = 0; for (let i = 2; i < P.length; i += 3) mean += P[i]; mean /= P.length / 3;
  let nn = 0; for (let i = 2; i < P.length; i += 3) { P[i] -= mean; nn += P[i] * P[i]; } nn = Math.sqrt(nn); for (let i = 2; i < P.length; i += 3) P[i] /= nn;
  genericCache.set(key, P); return P;
}
function nccPts(g, w, h, H, pts, pol) {
  let n = 0, sx = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const [x, y] = apply(H, pts[i], pts[i + 1]), v = bil(g, w, h, x, y); if (Number.isNaN(v)) return -1;
    const d = -pol * v; n++; sx += d; sxx += d * d; sxy += d * pts[i + 2];
  }
  const vx = sxx - sx * sx / n; return vx > 0 ? sxy / Math.sqrt(vx) : -1; // template already zero-mean, unit norm
}
function refine(g, w, h, corners, n, pts, pol, m) {
  const SRC = [[0, 0], [n, 0], [n, n], [0, n]];
  let c = corners.map(p => p.slice()), H = homography(SRC, c), best = H ? nccPts(g, w, h, H, pts, pol) : -2;
  for (const step of [0.5, 0.25, 0.12, 0.06]) {
    for (let it = 0, improved = true; improved && it < 6; it++) {
      improved = false;
      for (let k = 0; k < 8; k++) for (const sg of [1, -1]) {
        const trial = c.map(p => p.slice()); trial[k >> 1][k & 1] += sg * step * m;
        const Ht = homography(SRC, trial); if (!Ht) continue;
        const s = nccPts(g, w, h, Ht, pts, pol);
        if (s > best) { best = s; c = trial; H = Ht; improved = true; }
      }
    }
  }
  return { corners: c, H, score: best };
}
// expected darkness at every module centre of a code, blurred by s modules (logo hole unknown)
const expCache = new Map();
function expected(id, mat, n, s) {
  const key = id + ':' + Math.round(s * 20); if (expCache.has(key)) return expCache.get(key);
  const K = kinds(n), B = blurGrid(n, (r, c) => (K[r * n + c] === 3 ? 0 : mat[r * n + c]), s), e = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) e[r * n + c] = gridAt(B, c + 0.5, r + 0.5);
  expCache.set(key, e); return e;
}
function readModules(g, w, h, H, n, pol, transpose) {
  const v = new Float32Array(n * n);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    let s = 0;
    for (const [du, dv] of [[0.35, 0.35], [0.65, 0.35], [0.35, 0.65], [0.65, 0.65]]) { const [x, y] = apply(H, c + du, r + dv); s += bil(g, w, h, x, y); }
    v[transpose ? c * n + r : r * n + c] = -pol * s / 4;
  }
  return v;
}
function corrOn(v, e, sel) {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const i of sel) { const x = v[i], y = e[i]; n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const vx = sxx - sx * sx / n, vy = syy - sy * sy / n; return vx > 0 && vy > 0 ? (sxy - sx * sy / n) / Math.sqrt(vx * vy) : 0;
}
// Squares that tell this code apart from other garments' codes: the squares of codewords that change
// with the garment ID (the ID's own bytes and the error-correction bytes computed from them), outside the
// logo. Compared against look-alike IDs (digits and letters in the same places, with this code's mask),
// whose average is taken out first, so what the IDs share in shape does not count as a match.
function telling(target, n, opts = {}) {
  const K = kinds(n), P = placement(n);
  const same = lookalikeIds(target.id, 160, opts.seed ?? 11).map(id => ({ id, mat: withMaskOf(garment(id).m, target.mat, n) }));
  const varies = new Set();
  for (let i = 0; i < n * n; i++) { const b = P.bitOf[i]; if (b < 0) continue; if (same.some(d => d.mat[i] !== target.mat[i])) varies.add(b >> 3); }
  const core = new Uint8Array(n * n), sel = [], grow = opts.grow ?? 1;
  for (let i = 0; i < n * n; i++) { const b = P.bitOf[i]; if (b >= 0 && K[i] === 0 && varies.has(b >> 3)) core[i] = 1; }
  // a blurred square also carries some of its neighbours, so the squares next to them count too
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (K[r * n + c] !== 0) continue;
    let near = false;
    for (let dr = -grow; dr <= grow && !near; dr++) for (let dc = -grow; dc <= grow; dc++) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < n && cc < n && core[rr * n + cc]) { near = true; break; } }
    if (near) sel.push(r * n + c);
  }
  // the average is taken over 60 of them; 100 others are the wrong IDs the score is compared with
  return { sel, same: same.slice(0, 60), nulls: same.slice(60, 160) };
}
// targets: [{ id, mat, sel, same, nulls }] (the owner's codes, with telling()). The part that look-alike
// codes share is taken out first, so only what is particular to each code is compared; z says how far
// the code's score stands above the scores of 100 wrong look-alike IDs.
function verify(g, w, h, H, n, pol, transpose, targets, s) {
  return verifyValues(readModules(g, w, h, H, n, pol, transpose), n, targets, s);
}
function verifyValues(v, n, targets, s) {
  let best = null;
  for (const t of targets) {
    const sel = t.sel, M = new Float32Array(n * n);
    for (const d of t.same) { const e = expected(d.id, d.mat, n, s); for (const i of sel) M[i] += e[i] / t.same.length; }
    // fit v = a M + b on the selected squares, keep what is left
    let sm = 0, sv = 0, smm = 0, smv = 0; for (const i of sel) { sm += M[i]; sv += v[i]; smm += M[i] * M[i]; smv += M[i] * v[i]; }
    const k = sel.length, a = (smv - sm * sv / k) / Math.max(1e-9, smm - sm * sm / k), b = (sv - a * sm) / k;
    const rest = new Float32Array(n * n); for (const i of sel) rest[i] = v[i] - a * M[i] - b;
    const score = (id, mat) => { const e = expected(id, mat, n, s), d = new Float32Array(n * n); for (const i of sel) d[i] = e[i] - M[i]; return corrOn(rest, d, sel); };
    const r = score(t.id, t.mat), rd = t.nulls.map(d => score(d.id, d.mat));
    const mean = rd.reduce((p, q) => p + q, 0) / rd.length, sd = Math.sqrt(rd.reduce((p, q) => p + (q - mean) ** 2, 0) / rd.length);
    const z = (r - mean) / Math.max(sd, 0.02);
    if (!best || z > best.z) best = { id: t.id, r, z, decoyMax: Math.max(...rd), mean, sd, n: sel.length, a };
  }
  return best;
}

// The whole search on a grey photo: corner marks, groups of three, then each group's squares compared
// with the owner's codes.
const SCALES = [1.3, 1.56, 1.87, 2.25, 2.7, 3.24]; // pixels per square; bigger codes are read the normal way
const prepared = new Map();
function target(id) { // the code's squares plus what is needed to tell it from other codes (cached)
  if (!prepared.has(id)) { const g = garment(id), t = { id, mat: g.m, n: g.n }; Object.assign(t, telling(t, g.n)); prepared.set(id, t); }
  return prepared.get(id);
}
function knownCodes(img, ids, opts = {}) {
  const { g, w, h } = img, T = [], t0 = Date.now(), zMin = opts.zMin ?? 5.5;
  const byN = new Map(); for (const id of ids) { const t = target(id); (byN.get(t.n) || byN.set(t.n, []).get(t.n)).push(t); }
  const sp = spots(g, w, h, integral(g, w, h), SCALES, { T: 12 }); T.push(Date.now());
  const ex = sp.map(s => examineFast(g, w, h, s)).filter(e => e && e.r >= 0.5).sort((a, b) => b.r - a.r), kept = [];
  for (const e of ex) if (!kept.some(k => Math.abs(k.x - e.x) < 1.2 * e.m && Math.abs(k.y - e.y) < 1.2 * e.m && k.m / e.m < 1.3 && e.m / k.m < 1.3)) kept.push(e);
  for (const e of kept) stretch(g, w, h, e);
  T.push(Date.now());
  const found = [], tried = []; let groups = 0;
  for (const [n, targets] of byN) {
    const tr = triplets(g, w, h, kept, n, { mirrored: true }), SRC = [[0, 0], [n, 0], [n, n], [0, n]]; groups += tr.length;
    // rank the groups by how well the parts every code shares fit at their first outline
    for (const k of tr) {
      const { a, ex: ux, ey: uy } = k, P = (u, v) => [a.x + (u - 3.5) * ux[0] + (v - 3.5) * uy[0], a.y + (u - 3.5) * ux[1] + (v - 3.5) * uy[1]];
      k.corners = SRC.map(([u, v]) => P(u, v)); k.mm = Math.sqrt(Math.abs(ux[0] * uy[1] - ux[1] * uy[0]));
      const H = homography(SRC, k.corners); k.fit = H ? fitShared(g, w, h, H, generic(targets[0].mat, n, 1.2 / k.mm), a.pol) : -1;
    }
    tr.sort((p, q) => q.fit - p.fit);
    // the same code is often outlined several times; check each place once (and once mirrored)
    const picks = [];
    for (const k of tr) {
      if (k.fit <= 0) break;
      const cx = k.corners.reduce((p, q) => p + q[0], 0) / 4, cy = k.corners.reduce((p, q) => p + q[1], 0) / 4;
      if (picks.some(p => p.mirrored === k.mirrored && Math.hypot(p.cx - cx, p.cy - cy) < 4 * Math.max(p.mm, k.mm))) continue;
      k.cx = cx; k.cy = cy; picks.push(k);
      if (picks.length >= (opts.maxVerify ?? 8)) break;
    }
    for (const k of picks) {
      const { a, corners, mm } = k, s = 1.2 / mm;
      const R = refine(g, w, h, corners, n, generic(targets[0].mat, n, s), a.pol, mm);
      const v = verify(g, w, h, R.H, n, a.pol, k.mirrored, targets, s);
      tried.push({ ...v, x: Math.round(a.x), y: Math.round(a.y), fit: R.score });
      if (v.z >= zMin && v.r >= 0.45 && v.r - v.decoyMax >= 0.1 && v.a > 0 && !found.some(f => f.id === v.id)) {
        found.push({ ...v, corners: R.corners });
        if (!opts.all && found.length === ids.length) break;
      }
    }
  }
  T.push(Date.now());
  return { found, tried, spots: sp.length, kept: kept.length, groups, ms: T.map((t, i) => t - (i ? T[i - 1] : t0)) };
}
function fitShared(g, w, h, H, pts, pol) {
  let k = 0, sx = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < pts.length; i += 3) { const [x, y] = apply(H, pts[i], pts[i + 1]), v = bil(g, w, h, x, y); if (Number.isNaN(v)) return -1; const d = -pol * v; k++; sx += d; sxx += d * d; sxy += d * pts[i + 2]; }
  const vx = sxx - sx * sx / k; return vx > 0 ? sxy / Math.sqrt(vx) : -1;
}

// ---- the page sends a grey photo and the owner's garment IDs ----
self.onmessage = ({ data }) => {
  try {
    const r = knownCodes({ g: data.gray, w: data.width, h: data.height }, data.ids);
    self.postMessage({ found: r.found.map(f => ({ id: f.id, corners: f.corners, z: f.z })) });
  } catch (e) {
    self.postMessage({ error: String((e && e.message) || e) });
  }
};
