/* ------------------------------------------------------------------
   Minimal PDF writer - no external libraries.

   Builds a valid PDF 1.4 byte stream by hand: catalog, page tree,
   Helvetica / Helvetica-Bold (base-14, so no font embedding needed),
   uncompressed content streams, and JPEG photos as DCTDecode image
   XObjects.

   Everything the report needs is here: shaded table rows, coloured
   status pills, word wrapping, automatic page breaks and page numbers.
   ------------------------------------------------------------------ */

const PT = {
  pageW: 595.28,   // A4
  pageH: 841.89,
  margin: 42
};

/* Adobe base-14 advance widths (units of 1/1000 em) for codes 32-126.
   Needed so text can be centred, right-aligned and wrapped properly. */
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,
  1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,
  333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,
  556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,
  975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,
  667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,
  333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,
  611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/* Unicode -> WinAnsi byte, for the handful of non-ASCII characters
   that legitimately show up in a plant report. Anything else that is
   not printable Latin-1 gets dropped rather than corrupting the file. */
const WINANSI_MAP = {
  0x00B0: 0xB0, // degree
  0x00B2: 0xB2, // superscript two
  0x00B3: 0xB3, // superscript three
  0x00B1: 0xB1, // plus-minus
  0x00B7: 0xB7, // middle dot
  0x00BD: 0xBD, 0x00BC: 0xBC,
  0x2013: 0x96, // en dash
  0x2014: 0x97, // em dash
  0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94,
  0x2022: 0xB7, // bullet -> middle dot
  0x00E9: 0xE9, 0x00E8: 0xE8, 0x00FC: 0xFC, 0x00F6: 0xF6, 0x00E4: 0xE4
};

const ASCII_FALLBACK = {
  0x2265: '>=', 0x2264: '<=', 0x2192: '->', 0x2190: '<-',
  0x00D7: 'x',  0x2026: '...', 0x00A0: ' '
};

/* Convert a JS string into an array of WinAnsi byte values. */
function toWinAnsi(str) {
  const out = [];
  for (const ch of String(str == null ? '' : str)) {
    const cp = ch.codePointAt(0);
    if (cp === 9) { out.push(32); continue; }
    if (cp < 32) continue;
    if (cp < 127) { out.push(cp); continue; }
    if (WINANSI_MAP[cp] !== undefined) { out.push(WINANSI_MAP[cp]); continue; }
    if (ASCII_FALLBACK[cp] !== undefined) {
      for (const c of ASCII_FALLBACK[cp]) out.push(c.charCodeAt(0));
      continue;
    }
    if (cp >= 0xA1 && cp <= 0xFF) { out.push(cp); continue; }
    // Emoji, CJK, anything else with no Latin-1 home: skip it.
  }
  return out;
}

function charWidth(byte, bold) {
  if (byte >= 32 && byte <= 126) return (bold ? W_BOLD : W_REG)[byte - 32];
  if (byte === 0xB3 || byte === 0xB2) return 333;
  if (byte === 0xB0) return 400;
  if (byte === 0xB7) return 278;
  if (byte === 0x96) return 556;
  if (byte === 0x97) return 1000;
  return bold ? 611 : 556;
}

function measure(str, size, bold, tracking) {
  const bytes = toWinAnsi(str);
  let total = 0;
  for (const b of bytes) total += charWidth(b, bold);
  let w = (total / 1000) * size;
  if (tracking && bytes.length > 1) w += tracking * (bytes.length - 1);
  return w;
}

/* Escape a WinAnsi byte array into a PDF literal string body. */
function pdfStringBody(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0x28) s += '\\(';
    else if (b === 0x29) s += '\\)';
    else if (b === 0x5C) s += '\\\\';
    else if (b < 32 || b > 126) s += '\\' + b.toString(8).padStart(3, '0');
    else s += String.fromCharCode(b);
  }
  return s;
}

function wrapText(str, size, bold, maxWidth) {
  const words = String(str == null ? '' : str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (measure(test, size, bold) <= maxWidth || !line) {
      line = test;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function fmtColour(rgb) {
  return rgb.map(v => (v / 255).toFixed(3)).join(' ');
}

/* ------------------------------------------------------------------ */

class PdfDoc {
  constructor() {
    this.pages = [];
    this.images = [];      // { name, bytes, width, height }
    this.page = null;
    this.y = 0;
    this.newPage();
  }

  newPage() {
    this.page = { ops: [] };
    this.pages.push(this.page);
    this.y = PT.margin;
    return this.page;
  }

  get contentWidth() { return PT.pageW - PT.margin * 2; }
  get bottomLimit() { return PT.pageH - PT.margin - 24; }

  /* y is tracked from the top of the page downwards; PDF wants it from
     the bottom, so every draw call converts at the last moment. */
  flip(yTop) { return PT.pageH - yTop; }

  ensure(height) {
    if (this.y + height > this.bottomLimit) {
      this.newPage();
      return true;
    }
    return false;
  }

  op(str) { this.page.ops.push(str); }

  rect(x, yTop, w, h, opts = {}) {
    const y = this.flip(yTop + h);
    if (opts.fill) {
      this.op(`${fmtColour(opts.fill)} rg`);
      this.op(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
    }
    if (opts.stroke) {
      this.op(`${fmtColour(opts.stroke)} RG`);
      this.op(`${(opts.lineWidth || 0.6).toFixed(2)} w`);
      this.op(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
    }
  }

  hline(x1, x2, yTop, colour = [222, 226, 230], lineWidth = 0.6) {
    const y = this.flip(yTop);
    this.op(`${fmtColour(colour)} RG`);
    this.op(`${lineWidth.toFixed(2)} w`);
    this.op(`${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
  }

  /* Draw one line of text. yTop is the baseline measured from the top. */
  text(str, x, yTop, opts = {}) {
    const size = opts.size || 9.5;
    const bold = !!opts.bold;
    const colour = opts.colour || [33, 37, 41];
    const bytes = toWinAnsi(str);
    if (!bytes.length) return;

    let drawX = x;
    const w = measure(str, size, bold, opts.tracking);
    if (opts.align === 'right') drawX = x - w;
    else if (opts.align === 'center') drawX = x - w / 2;

    this.op('BT');
    this.op(`${fmtColour(colour)} rg`);
    this.op(`/${opts.italic ? 'F3' : (bold ? 'F2' : 'F1')} ${size} Tf`);
    if (opts.tracking) this.op(`${opts.tracking} Tc`);
    this.op(`1 0 0 1 ${drawX.toFixed(2)} ${this.flip(yTop).toFixed(2)} Tm`);
    this.op(`(${pdfStringBody(bytes)}) Tj`);
    if (opts.tracking) this.op('0 Tc');
    this.op('ET');
  }

  /* Multi-line paragraph. Returns the height it consumed. */
  paragraph(str, x, yTop, maxWidth, opts = {}) {
    const size = opts.size || 9;
    const leading = opts.leading || size * 1.35;
    const lines = wrapText(str, size, !!opts.bold, maxWidth);
    lines.forEach((line, i) => {
      this.text(line, x, yTop + size + i * leading, opts);
    });
    return lines.length * leading;
  }

  /* Rounded-ish status pill: filled rect with white uppercase label. */
  pill(label, xRight, yTop, colour) {
    const size = 7.2;
    const padX = 5;
    const w = measure(label, size, true) + padX * 2;
    const h = 12;
    const x = xRight - w;
    this.rect(x, yTop, w, h, { fill: colour });
    this.text(label, x + padX, yTop + 8.6, { size, bold: true, colour: [255, 255, 255] });
    return w;
  }

  /* Rounded rectangle, built from four Bezier corners. */
  roundRect(x, yTop, w, h, r, opts = {}) {
    const y = this.flip(yTop + h);
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    const k = 0.5523 * rad;
    const f = (n) => n.toFixed(2);

    this.op(`${f(x + rad)} ${f(y)} m`);
    this.op(`${f(x + w - rad)} ${f(y)} l`);
    this.op(`${f(x + w - rad + k)} ${f(y)} ${f(x + w)} ${f(y + rad - k)} ${f(x + w)} ${f(y + rad)} c`);
    this.op(`${f(x + w)} ${f(y + h - rad)} l`);
    this.op(`${f(x + w)} ${f(y + h - rad + k)} ${f(x + w - rad + k)} ${f(y + h)} ${f(x + w - rad)} ${f(y + h)} c`);
    this.op(`${f(x + rad)} ${f(y + h)} l`);
    this.op(`${f(x + rad - k)} ${f(y + h)} ${f(x)} ${f(y + h - rad + k)} ${f(x)} ${f(y + h - rad)} c`);
    this.op(`${f(x)} ${f(y + rad)} l`);
    this.op(`${f(x)} ${f(y + rad - k)} ${f(x + rad - k)} ${f(y)} ${f(x + rad)} ${f(y)} c`);
    this.op('h');

    if (opts.fill && opts.stroke) {
      this.op(`${fmtColour(opts.fill)} rg`);
      this.op(`${fmtColour(opts.stroke)} RG`);
      this.op(`${(opts.lineWidth || 0.7).toFixed(2)} w`);
      this.op('B');
    } else if (opts.fill) {
      this.op(`${fmtColour(opts.fill)} rg`);
      this.op('f');
    } else if (opts.stroke) {
      this.op(`${fmtColour(opts.stroke)} RG`);
      this.op(`${(opts.lineWidth || 0.7).toFixed(2)} w`);
      this.op('S');
    }
  }

  dashedLine(x1, x2, yTop, colour, opts = {}) {
    const y = this.flip(yTop);
    this.op('q');
    this.op(`[${opts.dash || '1.6 1.6'}] 0 d`);
    this.op(`${fmtColour(colour)} RG`);
    this.op(`${(opts.lineWidth || 0.6).toFixed(2)} w`);
    this.op(`${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S`);
    this.op('Q');
  }

  /* Small status glyphs, drawn rather than typed since the base fonts have
     no symbols worth using. */
  icon(kind, cx, cyTop, size, colour) {
    const cy = this.flip(cyTop);
    const s = size / 2;
    this.op('q');
    this.op(`${fmtColour(colour)} RG`);
    this.op('1 J 1 j');
    this.op(`${(size * 0.26).toFixed(2)} w`);
    if (kind === 'tick') {
      this.op(`${(cx - s).toFixed(2)} ${(cy + s * 0.08).toFixed(2)} m`);
      this.op(`${(cx - s * 0.22).toFixed(2)} ${(cy - s * 0.62).toFixed(2)} l`);
      this.op(`${(cx + s).toFixed(2)} ${(cy + s * 0.72).toFixed(2)} l S`);
    } else if (kind === 'cross') {
      this.op(`${(cx - s * 0.7).toFixed(2)} ${(cy - s * 0.7).toFixed(2)} m ${(cx + s * 0.7).toFixed(2)} ${(cy + s * 0.7).toFixed(2)} l S`);
      this.op(`${(cx - s * 0.7).toFixed(2)} ${(cy + s * 0.7).toFixed(2)} m ${(cx + s * 0.7).toFixed(2)} ${(cy - s * 0.7).toFixed(2)} l S`);
    } else if (kind === 'bang') {
      this.op(`${cx.toFixed(2)} ${(cy + s * 0.85).toFixed(2)} m ${cx.toFixed(2)} ${(cy - s * 0.1).toFixed(2)} l S`);
      this.op(`${cx.toFixed(2)} ${(cy - s * 0.72).toFixed(2)} m ${cx.toFixed(2)} ${(cy - s * 0.7).toFixed(2)} l S`);
    } else if (kind === 'dash') {
      this.op(`${(cx - s * 0.7).toFixed(2)} ${cy.toFixed(2)} m ${(cx + s * 0.7).toFixed(2)} ${cy.toFixed(2)} l S`);
    }
    this.op('Q');
  }

  /* Pill badge with a drawn glyph and a label. */
  badge(label, kind, xRight, yTop, colour) {
    const size = 7;
    const h = 13;
    const iconW = 8;
    const padX = 6;
    const labelW = measure(label, size, true, 0.25);
    const w = padX + iconW + 3.5 + labelW + padX;
    const x = xRight - w;
    this.roundRect(x, yTop, w, h, h / 2, { fill: colour });
    this.icon(kind, x + padX + iconW / 2, yTop + h / 2, iconW, [255, 255, 255]);
    this.text(label, x + padX + iconW + 3.5, yTop + 9,
      { size, bold: true, colour: [255, 255, 255], tracking: 0.25 });
    return w;
  }

  addImage(bytes, width, height) {
    const name = `Im${this.images.length + 1}`;
    this.images.push({ name, bytes, width, height });
    return name;
  }

  drawImage(name, x, yTop, w, h) {
    const y = this.flip(yTop + h);
    this.op('q');
    this.op(`${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm`);
    this.op(`/${name} Do`);
    this.op('Q');
  }

  /* ---------------- assembly ---------------- */

  build(footerText) {
    this.stampFooters(footerText);

    const chunks = [];
    const offsets = [];
    let length = 0;

    const push = (data) => {
      const bytes = typeof data === 'string' ? latin1Bytes(data) : data;
      chunks.push(bytes);
      length += bytes.length;
    };

    const startObj = (num) => { offsets[num] = length; push(`${num} 0 obj\n`); };
    const endObj = () => push('endobj\n');

    const pageCount = this.pages.length;
    const imgCount = this.images.length;

    // Object numbering:
    //   1 catalog, 2 pages, 3 F1, 4 F2, 5 F3 (italic)
    //   6 .. 6+img-1            image xobjects
    //   then per page: page object + content stream
    const imgFirst = 6;
    const pageFirst = imgFirst + imgCount;

    push('%PDF-1.4\n');
    push(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])); // binary marker

    startObj(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\n');
    endObj();

    const kids = [];
    for (let i = 0; i < pageCount; i++) kids.push(`${pageFirst + i * 2} 0 R`);
    startObj(2);
    push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pageCount} >>\n`);
    endObj();

    startObj(3);
    push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n');
    endObj();

    startObj(4);
    push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n');
    endObj();

    startObj(5);
    push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>\n');
    endObj();

    this.images.forEach((img, i) => {
      startObj(imgFirst + i);
      push(`<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} ` +
           `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`);
      push(img.bytes);
      push('\nendstream\n');
      endObj();
    });

    const xobjEntries = this.images.map((img, i) => `/${img.name} ${imgFirst + i} 0 R`).join(' ');

    this.pages.forEach((pg, i) => {
      const pageObj = pageFirst + i * 2;
      const contentObj = pageObj + 1;
      const body = pg.ops.join('\n') + '\n';
      const bodyBytes = latin1Bytes(body);

      startObj(pageObj);
      push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PT.pageW} ${PT.pageH}] ` +
           `/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >>` +
           (xobjEntries ? ` /XObject << ${xobjEntries} >>` : '') +
           ` >> /Contents ${contentObj} 0 R >>\n`);
      endObj();

      startObj(contentObj);
      push(`<< /Length ${bodyBytes.length} >>\nstream\n`);
      push(bodyBytes);
      push('endstream\n');
      endObj();
    });

    const maxObj = pageFirst + pageCount * 2 - 1;
    const xrefStart = length;
    push(`xref\n0 ${maxObj + 1}\n`);
    push('0000000000 65535 f \n');
    for (let n = 1; n <= maxObj; n++) {
      push(String(offsets[n] || 0).padStart(10, '0') + ' 00000 n \n');
    }
    push(`trailer\n<< /Size ${maxObj + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`);

    const out = new Uint8Array(length);
    let pos = 0;
    for (const c of chunks) { out.set(c, pos); pos += c.length; }
    return out;
  }

  stampFooters(footerText) {
    const total = this.pages.length;
    this.pages.forEach((pg, i) => {
      const saved = this.page;
      this.page = pg;
      const yTop = PT.pageH - PT.margin + 6;
      this.hline(PT.margin, PT.pageW - PT.margin, yTop - 10, [233, 236, 239]);
      if (footerText) {
        this.text(footerText, PT.margin, yTop, { size: 7.5, colour: [130, 137, 145] });
      }
      this.text(`Page ${i + 1} of ${total}`, PT.pageW - PT.margin, yTop,
        { size: 7.5, colour: [130, 137, 145], align: 'right' });
      this.page = saved;
    });
  }
}

function latin1Bytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xFF;
  return out;
}
