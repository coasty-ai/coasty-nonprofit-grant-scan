/**
 * Offline portal renderer: turns a unit's `portal` block into a sequence of
 * 1280x720 frames that read like a real browser working through the task.
 *
 * These are the frames anyone who clones the repo and runs `npm run demo` with
 * no key will see, so they have to be a genuine demonstration — a browser
 * chrome, the real URL, a search being typed, results filling in, and the
 * answer highlighted at the end — not abstract colour blocks.
 *
 * Zero dependencies: everything is drawn with tools/render.mjs.
 */
import { Canvas, drawText, drawClipped, textWidth } from './render.mjs';

const W = 1280;
const H = 720;

const C = {
  chrome: [38, 40, 48],
  chromeLight: [58, 61, 71],
  tab: [24, 26, 32],
  page: [255, 255, 255],
  ink: [24, 26, 32],
  muted: [122, 128, 140],
  line: [226, 229, 235],
  accent: [29, 100, 220],
  accentSoft: [232, 240, 254],
  headerBar: [17, 42, 88],
  ok: [22, 128, 68],
  okSoft: [231, 246, 236],
  shade: [247, 248, 251],
  caret: [29, 100, 220],
};

/** Browser chrome: window buttons, one tab, and the address bar. */
function chrome(cv, url, { loading = false, progress = 0 } = {}) {
  cv.fill(0, 0, W, 84, C.chrome);
  // window buttons
  const dots = [[237, 106, 94], [245, 191, 79], [98, 197, 84]];
  dots.forEach(([r, g, b], i) => cv.fill(20 + i * 22, 18, 12, 12, [r, g, b]));

  // tab
  cv.fill(96, 8, 360, 34, C.tab);
  drawClipped(cv, new URL(url).hostname, 112, 17, 330, [214, 218, 228], 2);

  // address bar
  cv.fill(20, 50, W - 40, 26, C.chromeLight);
  cv.fill(28, 56, 14, 14, [140, 200, 150]); // padlock-ish
  drawClipped(cv, url, 52, 57, W - 100, [226, 230, 240], 2);

  if (loading) {
    cv.fill(0, 82, Math.round(W * Math.min(1, progress)), 3, [90, 170, 255]);
  }
}

/** Site masthead + primary nav. */
function masthead(cv, site, nav) {
  cv.fill(0, 84, W, 74, C.headerBar);
  drawText(cv, site, 40, 106, [255, 255, 255], 3);
  let x = 40;
  cv.fill(0, 158, W, 34, [242, 244, 248]);
  for (const item of nav) {
    drawText(cv, item, x, 168, [70, 82, 104], 2);
    x += textWidth(item, 2) + 34;
  }
  cv.hline(0, 192, W, C.line);
}

/** Search box; `typed` characters are shown with a caret while typing. */
function searchBox(cv, label, typed, { focused = false, submitted = false } = {}) {
  const y = 224;
  drawText(cv, label, 40, y, C.muted, 2);
  const bx = 40;
  const by = y + 26;
  const bw = 720;
  const bh = 42;
  cv.fill(bx, by, bw, bh, focused ? [255, 255, 255] : C.shade);
  // border
  cv.fill(bx, by, bw, 2, focused ? C.accent : C.line);
  cv.fill(bx, by + bh - 2, bw, 2, focused ? C.accent : C.line);
  cv.fill(bx, by, 2, bh, focused ? C.accent : C.line);
  cv.fill(bx + bw - 2, by, 2, bh, focused ? C.accent : C.line);

  const tx = drawClipped(cv, typed, bx + 14, by + 13, bw - 40, C.ink, 2);
  if (focused && !submitted) cv.fill(tx + 2, by + 10, 2, 22, C.caret);

  // submit button
  cv.fill(bx + bw + 14, by, 128, bh, submitted ? C.accent : [222, 228, 238]);
  drawText(cv, 'Search', bx + bw + 44, by + 13, submitted ? [255, 255, 255] : [80, 90, 108], 2);
}

/**
 * Column x-positions sized from the actual content.
 *
 * A fixed grid handed 430px to a column holding "Drivers" while the carrier's
 * legal name got 324px and clipped — the layout has to follow the data, not the
 * other way round. Every column gets what its widest cell needs; if that
 * overflows the page, the surplus is taken proportionally from the widest
 * columns, so one long column cannot starve the rest.
 */
function layout(columns, rows) {
  const PAD = 28;
  const LEFT = 40;
  const AVAIL = W - LEFT * 2;
  const want = columns.map((c, i) =>
    Math.max(textWidth(c, 2), ...rows.map((r) => textWidth(String(r[i] ?? ''), 2))) + PAD,
  );
  const total = want.reduce((a, b) => a + b, 0);
  let widths = want;
  if (total > AVAIL) {
    // Shrink proportionally to how much each column exceeds an equal share.
    const fair = AVAIL / columns.length;
    const over = want.map((w) => Math.max(0, w - fair));
    const overTotal = over.reduce((a, b) => a + b, 0) || 1;
    const excess = total - AVAIL;
    widths = want.map((w, i) => Math.max(90, Math.round(w - (over[i] / overTotal) * excess)));
  }
  const xs = [];
  let x = LEFT;
  for (const w of widths) {
    xs.push(x);
    x += w;
  }
  return { xs, widths };
}

/** Results table. `visible` rows are drawn; `highlight` is drawn in success green. */
function table(cv, columns, rows, visible, { highlight = -1, note = '' } = {}) {
  const top = 320;
  const { xs, widths } = layout(columns, rows);
  cv.fill(0, top, W, 34, C.shade);
  columns.forEach((c, i) => drawClipped(cv, c, xs[i], top + 10, widths[i] - 14, [90, 98, 114], 2));
  cv.hline(0, top + 34, W, C.line);

  const rowH = 44;
  // The status strip is up to two lines (14 + 2*20 = 54px). Reserve the worst
  // case, plus a note line, so neither can ever be overlapped.
  const STATUS_H = 54;
  const NOTE_H = 24;
  const floor = H - STATUS_H - NOTE_H;
  const maxRows = Math.max(1, Math.floor((floor - (top + 34)) / rowH));

  // Scroll so the answer is always on screen. A table taller than the viewport
  // would otherwise hide the very row the run exists to find — which is exactly
  // what a real browser scrolling to its result would never do.
  const shown = Math.min(visible, rows.length);
  const start =
    highlight >= 0 && highlight >= maxRows
      ? Math.min(highlight - maxRows + 1, Math.max(0, rows.length - maxRows))
      : Math.max(0, Math.min(shown, rows.length) - maxRows) > 0 && shown > maxRows
        ? shown - maxRows
        : 0;

  let drawn = 0;
  for (let i = start; i < shown && drawn < maxRows; i++) {
    const y = top + 34 + drawn * rowH;
    drawn++;
    const isHi = i === highlight;
    if (isHi) cv.fill(0, y, W, rowH, C.okSoft);
    else if (i % 2 === 1) cv.fill(0, y, W, rowH, [251, 252, 254]);
    rows[i].forEach((cell, ci) => {
      drawClipped(cv, cell, xs[ci], y + 14, widths[ci] - 14, isHi ? C.ok : ci === 0 ? C.ink : C.muted, 2);
    });
    cv.hline(0, y + rowH - 1, W, C.line);
    if (isHi) cv.fill(0, y, 5, rowH, C.ok);
  }

  if (note) {
    // Clamp above the status strip: glyphs are 8 rows at scale 2 = 16px tall,
    // and the note used to be sliced in half by the bar on 7-row tables.
    const ny = Math.min(H - STATUS_H - 20, top + 34 + drawn * rowH + 4);
    drawText(cv, note, 40, ny, C.muted, 2);
  }
}

/** Greedy word wrap to a pixel width. */
function wrap(text, maxW, scale) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (line && textWidth(next, scale) > maxW) {
      lines.push(line);
      line = w;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Status strip: what the agent is doing right now.
 *
 * The answer WRAPS rather than clipping. Truncating it lost the actual finding
 * — "...dearest Full Moon over Noahs Ark G" dropped the price, so the frame
 * showed half an answer to a question the prompt asked in full.
 */
function status(cv, step, total, text) {
  const scale = 2;
  const lead = `step ${step}/${total}`;
  const leadW = textWidth(lead, scale) + 18;
  const avail = W - 16 - leadW - 16;
  const lines = wrap(text, avail, scale).slice(0, 2);
  const barH = 14 + lines.length * 20;
  const top = H - barH;

  cv.fill(0, top, W, barH, [17, 19, 24]);
  drawText(cv, lead, 16, top + 8, [140, 150, 170], scale);
  lines.forEach((l, i) => {
    // The second line is indented under the first, past the step counter.
    drawClipped(cv, l, 16 + leadW, top + 8 + i * 20, avail, [225, 230, 240], scale);
  });
  cv.fill(0, top - 3, Math.round((W * step) / Math.max(1, total)), 3, [90, 170, 255]);
  return barH;
}

/**
 * Render one frame of the demo.
 *
 * The scene advances with `step` so consecutive frames are visibly different
 * (the capture pipeline asserts adjacent-frame distinctness) and together they
 * tell the story of the task: load → search → results → answer.
 */
export function renderFrame(unit, step, total) {
  const p = unit.portal ?? {};
  const url = p.url ?? `https://${unit.target}`;
  const site = p.site ?? unit.target;
  const nav = p.nav ?? ['Home', 'Search', 'Data', 'About', 'Help'];
  const query = p.query ?? '';
  const columns = p.columns ?? ['Result', 'Detail', 'Date', 'Reference'];
  const rows = p.rows ?? [];
  const cv = new Canvas(W, H, C.page);

  // Phase boundaries, proportional to the run so any step budget looks natural.
  const nav1 = 1;                                  // navigating
  const typeEnd = nav1 + Math.max(2, Math.round(total * 0.25)); // typing the query
  const submit = typeEnd + 1;                      // submitted / loading
  const rowsEnd = total - 1;                       // results filling in

  if (step <= nav1) {
    chrome(cv, url, { loading: true, progress: 0.35 });
    cv.fill(0, 84, W, H - 118, [252, 253, 255]);
    drawText(cv, 'Loading...', 40, 140, C.muted, 3);
    status(cv, step, total, `Navigating to ${new URL(url).hostname}`);
    return cv.toPNG();
  }

  chrome(cv, url);
  masthead(cv, site, nav);

  if (step <= typeEnd) {
    const frac = (step - nav1) / Math.max(1, typeEnd - nav1);
    const shown = query.slice(0, Math.max(1, Math.round(query.length * frac)));
    searchBox(cv, p.label ?? 'Search', shown, { focused: true });
    drawText(cv, p.hint ?? 'Enter a term and press Search.', 40, 300, C.muted, 2);
    status(cv, step, total, `Typing "${shown}"`);
    return cv.toPNG();
  }

  searchBox(cv, p.label ?? 'Search', query, { focused: false, submitted: true });

  if (step === submit) {
    drawText(cv, 'Searching...', 40, 330, C.muted, 3);
    status(cv, step, total, 'Submitting the search');
    return cv.toPNG();
  }

  const span = Math.max(1, rowsEnd - submit);
  const visible = Math.min(rows.length, Math.ceil(((step - submit) / span) * rows.length));
  const done = step >= total;
  table(cv, columns, rows, done ? rows.length : visible, {
    highlight: done ? (p.answerRow ?? rows.length - 1) : -1,
    note: p.note ?? (p.total ? `${p.total} results` : ''),
  });
  status(
    cv,
    step,
    total,
    done ? p.answer ?? 'Reporting the result' : `Reading results (${Math.min(visible, rows.length)}/${rows.length})`,
  );
  return cv.toPNG();
}
