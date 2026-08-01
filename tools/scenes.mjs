/**
 * Scene primitives for the offline portal renderer.
 *
 * A federal grid dashboard, a chemical datasheet and a product storefront do
 * not look like each other, and rendering all three as "chrome + search box +
 * table" produces twelve demos that are visibly the same video with different
 * words. Each archetype below is a real page shape, so a unit's flow can be
 * assembled from the ones its actual site uses.
 *
 * Zero dependencies — everything draws through tools/render.mjs.
 */
import { Canvas, drawText, drawClipped, textWidth } from './render.mjs';

export const W = 1280;
export const H = 720;

/** Default palette; a unit's `theme` overrides any of these. */
export const BASE = {
  bar: [17, 42, 88],
  accent: [29, 100, 220],
  ink: [24, 26, 32],
  muted: [122, 128, 140],
  line: [226, 229, 235],
  shade: [247, 248, 251],
  page: [255, 255, 255],
  ok: [22, 128, 68],
  okSoft: [231, 246, 236],
  warn: [176, 96, 12],
  chrome: [38, 40, 48],
};

export const theme = (t = {}) => ({ ...BASE, ...t });

// ── chrome ───────────────────────────────────────────────────────────────────

export function chrome(cv, C, url, { loading = false, progress = 0 } = {}) {
  cv.fill(0, 0, W, 84, C.chrome);
  [[237, 106, 94], [245, 191, 79], [98, 197, 84]].forEach((c, i) =>
    cv.fill(20 + i * 22, 18, 12, 12, c),
  );
  cv.fill(96, 8, 380, 34, [24, 26, 32]);
  let host = url;
  try {
    host = new URL(url).hostname;
  } catch {
    /* keep the raw string */
  }
  drawClipped(cv, host, 112, 17, 350, [214, 218, 228], 2);
  cv.fill(20, 50, W - 40, 26, [58, 61, 71]);
  cv.fill(28, 56, 14, 14, [140, 200, 150]);
  drawClipped(cv, url, 52, 57, W - 100, [226, 230, 240], 2);
  if (loading) cv.fill(0, 82, Math.round(W * Math.min(1, progress)), 3, [90, 170, 255]);
}

export function masthead(cv, C, site, nav = [], { sub = '' } = {}) {
  cv.fill(0, 84, W, sub ? 82 : 74, C.bar);
  drawText(cv, site, 40, sub ? 100 : 106, [255, 255, 255], 3);
  if (sub) drawText(cv, sub, 40, 134, [190, 205, 235], 2);
  const navY = 84 + (sub ? 82 : 74);
  // A page that genuinely has no nav (a bare sign-in screen) must not get an
  // empty 34px grey band: a full-width chrome bar with nothing in it reads as
  // a strip that failed to render, not as a page without navigation.
  if (!nav.length) {
    cv.hline(0, navY, W, C.line);
    return navY;
  }
  cv.fill(0, navY, W, 34, [242, 244, 248]);
  let x = 40;
  for (const item of nav) {
    drawText(cv, item, x, navY + 10, [70, 82, 104], 2);
    x += textWidth(item, 2) + 34;
  }
  cv.hline(0, navY + 34, W, C.line);
  return navY + 34; // content top
}

// ── status strip ─────────────────────────────────────────────────────────────

export function wrap(text, maxW, scale) {
  const out = [];
  let line = '';
  for (const w of String(text).split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${w}` : w;
    if (line && textWidth(next, scale) > maxW) {
      out.push(line);
      line = w;
    } else line = next;
  }
  if (line) out.push(line);
  return out;
}

export const STATUS_H = 54;

/**
 * Baseline for a footer note. `STATUS_H + 20` left exactly one clear pixel row
 * between a note's descenders and the status strip's progress bar — correct,
 * but one glyph-metric change away from text disappearing under the strip.
 */
export const NOTE_Y = H - STATUS_H - 26;

export function status(cv, step, total, text) {
  const s = 2;
  const lead = `step ${step}/${total}`;
  const leadW = textWidth(lead, s) + 18;
  const avail = W - 16 - leadW - 16;
  const lines = wrap(text, avail, s).slice(0, 2);
  const barH = 14 + lines.length * 20;
  const top = H - barH;
  cv.fill(0, top, W, barH, [17, 19, 24]);
  drawText(cv, lead, 16, top + 8, [140, 150, 170], s);
  lines.forEach((l, i) => drawClipped(cv, l, 16 + leadW, top + 8 + i * 20, avail, [225, 230, 240], s));
  cv.fill(0, top - 3, Math.round((W * step) / Math.max(1, total)), 3, [90, 170, 255]);
}

// ── shared bits ──────────────────────────────────────────────────────────────

export function searchBox(cv, C, top, { label, typed, hint, focused, submitted, button = 'Search' }) {
  const y = top + 26;
  if (label) drawText(cv, label, 40, y, C.muted, 2);
  const by = y + 26;
  const bw = 700;
  const bh = 42;
  cv.fill(40, by, bw, bh, focused ? [255, 255, 255] : C.shade);
  for (const [x, yy, w, h] of [[40, by, bw, 2], [40, by + bh - 2, bw, 2], [40, by, 2, bh], [40 + bw - 2, by, 2, bh]]) {
    cv.fill(x, yy, w, h, focused ? C.accent : C.line);
  }
  const tx = drawClipped(cv, typed, 54, by + 13, bw - 40, C.ink, 2);
  if (focused && !submitted) cv.fill(tx + 2, by + 10, 2, 22, C.accent);
  cv.fill(40 + bw + 14, by, 150, bh, submitted ? C.accent : [222, 228, 238]);
  drawText(cv, button, 40 + bw + 14 + Math.round((150 - textWidth(button, 2)) / 2), by + 13,
    submitted ? [255, 255, 255] : [80, 90, 108], 2);
  if (hint) drawText(cv, hint, 40, by + bh + 14, C.muted, 2);
  return by + bh + (hint ? 44 : 24);
}

/** Column widths sized from content, shrunk proportionally if they overflow. */
function layout(columns, rows, left = 40, right = 40) {
  const AVAIL = W - left - right;
  const want = columns.map((c, i) =>
    Math.max(textWidth(c, 2), ...rows.map((r) => textWidth(String(r[i] ?? ''), 2))) + 28,
  );
  const total = want.reduce((a, b) => a + b, 0);
  let widths = want;
  if (total > AVAIL) {
    const fair = AVAIL / columns.length;
    const over = want.map((w) => Math.max(0, w - fair));
    const ot = over.reduce((a, b) => a + b, 0) || 1;
    const excess = total - AVAIL;
    widths = want.map((w, i) => Math.max(88, Math.round(w - (over[i] / ot) * excess)));
  }
  const xs = [];
  let x = left;
  for (const w of widths) {
    xs.push(x);
    x += w;
  }
  return { xs, widths };
}

// ── archetypes ───────────────────────────────────────────────────────────────

/** Results table. Scrolls so `highlight` is always on screen. */
export function table(cv, C, top, { columns, rows, visible, highlight = -1, note = '' }) {
  const { xs, widths } = layout(columns, rows);
  cv.fill(0, top, W, 34, C.shade);
  columns.forEach((c, i) => drawClipped(cv, c, xs[i], top + 10, widths[i] - 14, [90, 98, 114], 2));
  cv.hline(0, top + 34, W, C.line);
  const rowH = 44;
  const floor = H - STATUS_H - 24;
  const maxRows = Math.max(1, Math.floor((floor - (top + 34)) / rowH));
  const shown = Math.min(visible, rows.length);
  const start = highlight >= maxRows
    ? Math.min(highlight - maxRows + 1, Math.max(0, rows.length - maxRows))
    : shown > maxRows ? shown - maxRows : 0;
  let drawn = 0;
  for (let i = start; i < shown && drawn < maxRows; i++) {
    const y = top + 34 + drawn++ * rowH;
    const hi = i === highlight;
    if (hi) cv.fill(0, y, W, rowH, C.okSoft);
    else if (i % 2 === 1) cv.fill(0, y, W, rowH, [251, 252, 254]);
    rows[i].forEach((cell, ci) =>
      drawClipped(cv, cell, xs[ci], y + 14, widths[ci] - 14, hi ? C.ok : ci === 0 ? C.ink : C.muted, 2),
    );
    cv.hline(0, y + rowH - 1, W, C.line);
    if (hi) cv.fill(0, y, 5, rowH, C.ok);
  }
  if (note) drawText(cv, note, 40, Math.min(NOTE_Y, top + 34 + drawn * rowH + 4), C.muted, 2);
}

/**
 * Card grid — storefronts, opportunity listings, job boards.
 * Each item: { title, meta, value, tag }.
 */
export function cards(cv, C, top, { items, visible, highlight = -1, cols = 3, note = '' }) {
  const gap = 18;
  const left = 40;
  const cw = Math.floor((W - left * 2 - gap * (cols - 1)) / cols);
  const ch = 132;
  const floor = H - STATUS_H - 24;
  const maxRows = Math.max(1, Math.floor((floor - top) / (ch + gap)));
  const shown = Math.min(visible, items.length);
  const startRow = highlight >= 0 && Math.floor(highlight / cols) >= maxRows
    ? Math.floor(highlight / cols) - maxRows + 1
    : 0;
  for (let i = startRow * cols; i < shown; i++) {
    const r = Math.floor(i / cols) - startRow;
    if (r >= maxRows) break;
    const c = i % cols;
    const x = left + c * (cw + gap);
    const y = top + r * (ch + gap);
    const it = items[i];
    const hi = i === highlight;
    cv.fill(x, y, cw, ch, hi ? C.okSoft : [255, 255, 255]);
    cv.fill(x, y, cw, 3, hi ? C.ok : C.accent);
    for (const [bx, by, bw, bh] of [[x, y + ch - 1, cw, 1], [x, y, 1, ch], [x + cw - 1, y, 1, ch]]) {
      cv.fill(bx, by, bw, bh, C.line);
    }
    let ty = y + 18;
    for (const l of wrap(it.title ?? '', cw - 28, 2).slice(0, 2)) {
      drawClipped(cv, l, x + 14, ty, cw - 28, hi ? C.ok : C.ink, 2);
      ty += 20;
    }
    if (it.meta) drawClipped(cv, it.meta, x + 14, y + ch - 58, cw - 28, C.muted, 2);
    if (it.value) drawClipped(cv, it.value, x + 14, y + ch - 32, cw - 28, hi ? C.ok : C.ink, 3);
    if (it.tag) {
      const tw = textWidth(it.tag, 2) + 16;
      cv.fill(x + cw - tw - 12, y + ch - 34, tw, 24, hi ? C.ok : C.shade);
      drawText(cv, it.tag, x + cw - tw - 4, y + ch - 28, hi ? [255, 255, 255] : C.muted, 2);
    }
  }
  if (note) drawText(cv, note, 40, NOTE_Y, C.muted, 2);
}

/**
 * Field/value record — a SAFER snapshot, an NPI detail page.
 * `fields` is [[label, value], ...]; `highlight` indexes into it.
 */
export function fields(cv, C, top, { title, fields: fs, visible, highlight = -1, cols = 2 }) {
  let y = top + 6;
  if (title) {
    drawText(cv, title, 40, y, C.ink, 3);
    y += 40;
  }
  const gap = 24;
  const cw = Math.floor((W - 80 - gap) / cols);
  const rowH = 46;
  const shown = Math.min(visible, fs.length);
  for (let i = 0; i < shown; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    const x = 40 + c * (cw + gap);
    const fy = y + r * rowH;
    if (fy + rowH > H - STATUS_H - 8) break;
    const hi = i === highlight;
    if (hi) cv.fill(x - 6, fy - 4, cw + 12, rowH - 6, C.okSoft);
    const [k, v] = fs[i];
    drawClipped(cv, k, x, fy, Math.floor(cw * 0.46), C.muted, 2);
    drawClipped(cv, String(v), x + Math.floor(cw * 0.48), fy, Math.floor(cw * 0.52), hi ? C.ok : C.ink, 2);
    cv.hline(x, fy + rowH - 10, cw, C.line);
  }
}

/**
 * Dashboard — big stat tiles over a bar chart. For grid monitors, analytics.
 * `tiles` [{label, value, sub}], `series` [{label, value}] with numeric value.
 */
export function dashboard(cv, C, top, { tiles = [], series = [], visible, highlight = -1, note = '' }) {
  const n = Math.max(1, tiles.length);
  const gap = 16;
  const tw = Math.floor((W - 80 - gap * (n - 1)) / n);
  const th = 108;
  tiles.slice(0, Math.max(1, Math.min(n, visible))).forEach((t, i) => {
    const x = 40 + i * (tw + gap);
    cv.fill(x, top, tw, th, C.shade);
    cv.fill(x, top, 4, th, C.accent);
    drawClipped(cv, t.label ?? '', x + 16, top + 14, tw - 28, C.muted, 2);
    drawClipped(cv, String(t.value ?? ''), x + 16, top + 40, tw - 28, C.ink, 4);
    if (t.sub) drawClipped(cv, t.sub, x + 16, top + 80, tw - 28, C.muted, 2);
  });

  const cTop = top + th + 26;
  const floor = H - STATUS_H - 30;
  const chartH = Math.max(60, floor - cTop);
  const max = Math.max(1, ...series.map((s) => Number(s.value) || 0));
  const bw = Math.floor((W - 80) / Math.max(1, series.length));
  const showBars = Math.min(series.length, Math.max(0, visible - n));
  cv.hline(40, floor, W - 80, C.line);
  for (let i = 0; i < showBars; i++) {
    const s = series[i];
    const h = Math.round(((Number(s.value) || 0) / max) * (chartH - 34));
    const x = 40 + i * bw + 8;
    const hi = i === highlight;
    cv.fill(x, floor - h, bw - 16, h, hi ? C.ok : C.accent);
    drawClipped(cv, s.label ?? '', x, floor + 8, bw - 12, hi ? C.ok : C.muted, 2);
    if (s.display ?? s.value) {
      drawClipped(cv, String(s.display ?? s.value), x, floor - h - 20, bw - 12, hi ? C.ok : C.ink, 2);
    }
  }
  if (note) drawText(cv, note, 40, cTop - 20, C.muted, 2);
}

/**
 * Datasheet — a document-style record: heading, subtitle, then property pairs
 * in a bordered panel. NIST WebBook, spec sheets, catalogue entries.
 */
export function datasheet(cv, C, top, { title, subtitle, rows = [], visible, highlight = -1, note = '' }) {
  let y = top + 8;
  if (title) {
    drawClipped(cv, title, 40, y, W - 80, C.ink, 4);
    y += 44;
  }
  if (subtitle) {
    drawClipped(cv, subtitle, 40, y, W - 80, C.muted, 2);
    y += 30;
  }
  const panelTop = y + 6;
  const rowH = 42;
  const floor = H - STATUS_H - 24;
  const maxRows = Math.max(1, Math.floor((floor - panelTop - 12) / rowH));
  const shown = Math.min(visible, rows.length, maxRows);
  cv.fill(40, panelTop, W - 80, Math.min(floor - panelTop, shown * rowH + 12), [252, 253, 255]);
  cv.fill(40, panelTop, 4, Math.min(floor - panelTop, shown * rowH + 12), C.accent);
  for (let i = 0; i < shown; i++) {
    const ry = panelTop + 8 + i * rowH;
    const hi = i === highlight;
    if (hi) cv.fill(44, ry - 4, W - 88, rowH - 6, C.okSoft);
    const [k, v, unit] = rows[i];
    drawClipped(cv, k, 62, ry + 8, 420, C.muted, 2);
    drawClipped(cv, String(v), 500, ry + 8, 480, hi ? C.ok : C.ink, 2);
    if (unit) drawClipped(cv, unit, 1000, ry + 8, 240, C.muted, 2);
    cv.hline(62, ry + rowH - 10, W - 124, C.line);
  }
  if (note) drawText(cv, note, 40, Math.min(floor + 4, NOTE_Y), C.muted, 2);
}

/** A login form. `fields` is [[label, value], ...]; the last one masks. */
export function login(cv, C, top, { title = 'Sign in', fields: fs = [], typedIdx = -1, note = '' }) {
  const bw = 460;
  const x = Math.round((W - bw) / 2);
  const y = top + 40;
  const bh = 74 + fs.length * 72;
  cv.fill(x, y, bw, bh, [255, 255, 255]);
  for (const [bx, by, w, h] of [[x, y, bw, 2], [x, y + bh - 2, bw, 2], [x, y, 2, bh], [x + bw - 2, y, 2, bh]]) {
    cv.fill(bx, by, w, h, C.line);
  }
  drawText(cv, title, x + 24, y + 20, C.ink, 3);
  fs.forEach(([label, value], i) => {
    const fy = y + 66 + i * 72;
    drawText(cv, label, x + 24, fy, C.muted, 2);
    cv.fill(x + 24, fy + 22, bw - 48, 36, C.shade);
    const active = i === typedIdx;
    for (const [bx, by, w, h] of [[x + 24, fy + 22, bw - 48, 2], [x + 24, fy + 56, bw - 48, 2],
      [x + 24, fy + 22, 2, 36], [x + bw - 26, fy + 22, 2, 36]]) {
      cv.fill(bx, by, w, h, active ? C.accent : C.line);
    }
    const tx = drawClipped(cv, value, x + 36, fy + 31, bw - 72, C.ink, 2);
    if (active) cv.fill(tx + 2, fy + 28, 2, 24, C.accent);
  });
  if (note) {
    let ny = y + bh + 20;
    for (const l of wrap(note, bw, 2).slice(0, 3)) {
      drawText(cv, l, x, ny, C.muted, 2);
      ny += 22;
    }
  }
}

export { Canvas, drawText, drawClipped, textWidth };
