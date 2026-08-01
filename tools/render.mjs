/**
 * Zero-dependency raster renderer: PNG encoder + 5x7 bitmap font + the drawing
 * primitives the offline portal needs.
 *
 * Why this exists: the offline demo is the one almost everybody sees — clone,
 * `npm run demo`, no key, no spend. Abstract coloured blocks are not a demo of
 * an SEC filing search. Real text on a real-looking page is. Doing that with a
 * headless browser would mean a ~300 MB dependency in a repo whose entire pitch
 * is zero dependencies, so the font is inlined instead: 95 glyphs, 475 bytes.
 */
import { deflateSync } from 'node:zlib';

// ── PNG ──────────────────────────────────────────────────────────────────────

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

/** A mutable RGB canvas that encodes itself to PNG. */
export class Canvas {
  constructor(width, height, bg = [255, 255, 255]) {
    this.w = width;
    this.h = height;
    this.px = Buffer.alloc(width * height * 3);
    this.fill(0, 0, width, height, bg);
  }

  set(x, y, [r, g, b]) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const o = (y * this.w + x) * 3;
    this.px[o] = r;
    this.px[o + 1] = g;
    this.px[o + 2] = b;
  }

  fill(x, y, w, h, color) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) this.set(xx, yy, color);
    return this;
  }

  /** Rounded-ish rect: just clips the four corner pixels. Cheap, reads as soft. */
  card(x, y, w, h, color, radius = 3) {
    this.fill(x, y, w, h, color);
    for (let i = 0; i < radius; i++) {
      const k = radius - i - 1;
      for (let j = 0; j <= k; j++) {
        this.set(x + j, y + i, null ?? this.get(x + j, y + i));
      }
    }
    return this;
  }

  get(x, y) {
    const o = (y * this.w + x) * 3;
    return [this.px[o], this.px[o + 1], this.px[o + 2]];
  }

  hline(x, y, w, color) {
    return this.fill(x, y, w, 1, color);
  }

  toPNG() {
    const raw = Buffer.alloc(this.h * (1 + this.w * 3));
    let o = 0;
    for (let y = 0; y < this.h; y++) {
      raw[o++] = 0;
      this.px.copy(raw, o, y * this.w * 3, (y + 1) * this.w * 3);
      o += this.w * 3;
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

// ── 5x7 font, ASCII 0x20–0x7E. Five column bytes per glyph, LSB = top row. ───

const FONT = [
  '0000000000', '00005F0000', '0007000700', '147F147F14', '242A7F2A12', '2313086462',
  '3649552250', '0005030000', '001C224100', '0041221C00', '14083E0814', '08083E0808',
  '0050300000', '0808080808', '0060600000', '2010080402', '3E5149453E', '00427F4000',
  '4261514946', '2141454B31', '1814127F10', '2745454539', '3C4A494930', '0171090503',
  '3649494936', '064949291E', '0036360000', '0056360000', '0814224100', '1414141414',
  '0041221408', '0201510906', '3249794 13E'.replace(' ', ''), '7E1111117E', '7F49494936', '3E41414122',
  '7F4141221C', '7F49494941', '7F09090901', '3E4149497A', '7F0808087F', '00417F4100',
  '2040413F01', '7F08142241', '7F40404040', '7F020C027F', '7F0408107F', '3E4141413E',
  '7F09090906', '3E4151215E', '7F09192946', '4649494931', '01017F0101', '3F4040403F',
  '1F20402 01F'.replace(' ', ''), '3F40384 03F'.replace(' ', ''), '6314081463', '0708700807', '6151494543', '007F414100',
  '0204081020', '0041417F00', '0402010204', '4040404040', '0001020400', '2054545478',
  // 'g' deviates from the classic table on purpose: the stock 0C5252523E has no
  // descender in a 7-row cell and renders indistinguishably from '9' — ".gov"
  // came out as ".9ov". This variant keeps a visible tail.
  '7F48444438', '3844444420', '384444487F', '3854545418', '087E090102', '4C9292927C',
  '7F08040478', '00447D4000', '204044 3D00'.replace(' ', ''), '7F10284400', '00417F4000', '7C0418 0478'.replace(' ', ''),
  '7C08040478', '3844444438', '7C14141408', '0814141 87C'.replace(' ', ''), '7C08040408', '4854545420',
  '043F444020', '3C4040207C', '1C2040201C', '3C4030403C', '4428102844', '0C5050503C',
  '4464544C44', '0008364100', '00007F0000', '0041360800', '08082A1C08',
].map((h) => [0, 1, 2, 3, 4].map((i) => parseInt(h.slice(i * 2, i * 2 + 2), 16)));

const GLYPH_W = 5;
const GLYPH_H = 8; // row 7 exists so descenders can hang below the baseline

/** Width in pixels of `text` at `scale`, including 1px inter-glyph gap. */
export const textWidth = (text, scale = 2) => text.length * (GLYPH_W + 1) * scale;

/**
 * Draw text. Returns the x position just past the last glyph.
 * Unknown characters render as a filled block so a mistake is visible, never silent.
 */
export function drawText(cv, text, x, y, color = [24, 26, 32], scale = 2) {
  let cx = x;
  for (const ch of String(text)) {
    const idx = ch.charCodeAt(0) - 32;
    const glyph = idx >= 0 && idx < FONT.length ? FONT[idx] : null;
    for (let col = 0; col < GLYPH_W; col++) {
      const bits = glyph ? glyph[col] : 0x7f;
      for (let row = 0; row < GLYPH_H; row++) {
        if ((bits >> row) & 1) {
          cv.fill(cx + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cx += (GLYPH_W + 1) * scale;
  }
  return cx;
}

/** Draw text clipped to `maxW`, appending '...' when it would overflow (the font is ASCII-only). */
export function drawClipped(cv, text, x, y, maxW, color, scale = 2) {
  const per = (GLYPH_W + 1) * scale;
  const fits = Math.floor(maxW / per);
  const s = String(text);
  return drawText(cv, s.length <= fits ? s : `${s.slice(0, Math.max(0, fits - 3))}...`, x, y, color, scale);
}
