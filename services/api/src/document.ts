// Renders a study's document as a PDF: a report, portrait, or slides, 16:9. It is
// drawn in Helvetica, one of the fonts every PDF reader has, so nothing is embedded,
// in the display's colours. Every cited point carries the number of its source and
// its page, and the last page lists the sources.
import PDFDocument from "pdfkit";
import { DOCUMENT_LABEL, type DocumentKind } from "@transit-agents/contracts";

// The display's accent and ink, from apps/display/src/styles.css.
const ACCENT = "#b03488";
const ACCENT_INK = "#8e2a6e";
const INK = "#1d1d1f";
const MUTED = "#5f5f66";
const HAIRLINE = "#dcdce0";

const REGULAR = "Helvetica";
const BOLD = "Helvetica-Bold";

// A source a point cites, numbered in the order points first cite it.
export type Source = { n: number; name: string; pages: number[] };
export type RenderedPoint = { text: string; cite?: { n: number; page: number } };
export type RenderedSection = { heading: string; points: RenderedPoint[] };

export type DocumentContent = {
  kind: DocumentKind;
  title: string;
  study: string;
  date: string;
  sections: RenderedSection[];
  sources: Source[];
};

// The most bullets a slide holds. A longer section goes on over more slides.
export const SLIDE_POINTS = 5;

// The built-in fonts encode text as Windows-1252, so anything outside it is said in
// plain characters, or dropped, rather than drawn as the wrong glyph.
const PLAIN: Record<string, string> = { "→": "to", "←": "from", "≥": ">=", "≤": "<=", "≈": "about", "−": "-", "‑": "-", "×": "x", " ": " ", " ": " ", " ": " " };
const WIN_1252 = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");

export function printable(text: string): string {
  let out = "";
  for (const char of text.normalize("NFC")) {
    const code = char.codePointAt(0) as number;
    if (PLAIN[char] !== undefined) out += PLAIN[char];
    else if (char === "\n" || char === "\t") out += " ";
    else if ((code >= 0x20 && code < 0x7f) || (code >= 0xa0 && code <= 0xff) || WIN_1252.has(char)) out += char;
  }
  return out.replace(/ {2,}/g, " ").trim();
}

const citeMark = (cite: RenderedPoint["cite"]) => (cite ? ` [${cite.n}, p. ${cite.page}]` : "");

const pagesOf = (pages: number[]) => (pages.length === 1 ? `p. ${pages[0]}` : `pp. ${pages.join(", ")}`);

// Draws a point as a bullet at the cursor: its words in ink, its cite after them in
// the muted colour, the bullet in the accent.
function bullet(doc: PDFKit.PDFDocument, point: RenderedPoint, x: number, width: number, size: number, gap: number) {
  const y = doc.y;
  doc.save().fillColor(ACCENT).circle(x + size * 0.25, y + size * 0.55, size * 0.17).fill().restore();
  const indent = size * 1.1;
  doc.font(REGULAR).fontSize(size).fillColor(INK);
  const mark = citeMark(point.cite);
  const options = { width: width - indent, lineGap: size * 0.25 };
  if (mark) {
    doc.text(printable(point.text), x + indent, y, { ...options, continued: true });
    doc.fillColor(MUTED).fontSize(size * 0.8).text(mark, options);
  } else {
    doc.text(printable(point.text), x + indent, y, options);
  }
  doc.fontSize(size);
  doc.y += gap;
  doc.x = x;
}

const pointHeight = (doc: PDFKit.PDFDocument, point: RenderedPoint, width: number, size: number) =>
  doc.font(REGULAR).fontSize(size).heightOfString(`${printable(point.text)}${citeMark(point.cite)}`, { width: width - size * 1.1, lineGap: size * 0.25 });

// The foot of every page but the first: the label, and the page's number.
function footers(doc: PDFKit.PDFDocument, size: number, margin: number) {
  const { start, count } = doc.bufferedPageRange();
  for (let i = start + 1; i < start + count; i++) {
    doc.switchToPage(i);
    const { width, height } = doc.page;
    const bottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const y = height - margin * 0.6;
    doc.font(REGULAR).fontSize(size).fillColor(MUTED);
    doc.text(DOCUMENT_LABEL, margin, y, { width: width - margin * 2, lineBreak: false });
    doc.text(`${i + 1} / ${count}`, margin, y, { width: width - margin * 2, align: "right", lineBreak: false });
    doc.page.margins.bottom = bottom;
  }
}

function sourceLines(sources: Source[]): RenderedPoint[] {
  return sources.map((source) => ({ text: `[${source.n}] ${source.name}, ${pagesOf(source.pages)}` }));
}

function report(doc: PDFKit.PDFDocument, content: DocumentContent) {
  const margin = 72;
  const width = doc.page.width - margin * 2;

  // The title page.
  doc.rect(0, 0, doc.page.width, 14).fill(ACCENT);
  doc.font(BOLD).fontSize(11).fillColor(ACCENT_INK).text(printable(content.study).toUpperCase(), margin, 200, { width, characterSpacing: 0.6 });
  doc.moveDown(0.8);
  doc.font(BOLD).fontSize(30).fillColor(INK).text(printable(content.title), { width, lineGap: 4 });
  doc.moveDown(0.8);
  doc.font(REGULAR).fontSize(13).fillColor(MUTED).text(content.date, { width });
  doc.moveDown(2);
  doc.rect(margin, doc.y, 3, 34).fill(ACCENT);
  doc.font(BOLD).fontSize(12).fillColor(ACCENT_INK).text(DOCUMENT_LABEL, margin + 14, doc.y + 4, { width: width - 14 });
  doc.font(REGULAR).fontSize(10).fillColor(MUTED).text("Each point cites its source and page, listed at the end. A planner decides.", margin + 14, doc.y + 2, { width: width - 14 });

  const heading = (text: string) => {
    if (doc.y > doc.page.height - margin - 80) doc.addPage();
    doc.moveDown(0.6);
    doc.font(BOLD).fontSize(15).fillColor(ACCENT_INK).text(printable(text), margin, doc.y, { width });
    doc.moveTo(margin, doc.y + 3).lineTo(margin + width, doc.y + 3).lineWidth(0.6).strokeColor(HAIRLINE).stroke();
    doc.y += 10;
  };

  doc.addPage();
  for (const section of content.sections) {
    heading(section.heading);
    for (const point of section.points) {
      if (doc.y + pointHeight(doc, point, width, 11) > doc.page.height - margin) doc.addPage();
      bullet(doc, point, margin, width, 11, 5);
    }
  }
  if (content.sources.length) {
    heading("Sources");
    doc.font(REGULAR).fontSize(10).fillColor(INK);
    for (const line of sourceLines(content.sources)) doc.text(printable(line.text), margin, doc.y, { width, lineGap: 2 }).moveDown(0.3);
  }
  footers(doc, 8, margin);
}

function slides(doc: PDFKit.PDFDocument, content: DocumentContent) {
  const margin = 56;
  const width = doc.page.width - margin * 2;
  // Below the heading, and above the foot.
  const top = 150;
  const bottom = doc.page.height - 60;

  // The title slide.
  doc.rect(0, 0, 18, doc.page.height).fill(ACCENT);
  doc.font(BOLD).fontSize(14).fillColor(ACCENT_INK).text(printable(content.study).toUpperCase(), margin + 20, 150, { width: width - 20, characterSpacing: 0.6 });
  doc.moveDown(0.6);
  doc.font(BOLD).fontSize(40).fillColor(INK).text(printable(content.title), { width: width - 20, lineGap: 4 });
  doc.moveDown(0.6);
  doc.font(REGULAR).fontSize(18).fillColor(MUTED).text(content.date, { width: width - 20 });
  doc.moveDown(1.2);
  doc.font(BOLD).fontSize(16).fillColor(ACCENT_INK).text(DOCUMENT_LABEL, { width: width - 20 });

  const slide = (heading: string, points: RenderedPoint[], biggest: number) => {
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 8).fill(ACCENT);
    doc.font(BOLD).fontSize(30).fillColor(ACCENT_INK).text(printable(heading), margin, 52, { width, height: 80, ellipsis: true, lineGap: 2 });
    // The largest size, down to 12 points, at which every bullet fits.
    let size = biggest;
    const gap = (s: number) => s * 0.7;
    const total = (s: number) => points.reduce((sum, point) => sum + pointHeight(doc, point, width, s) + gap(s), 0);
    while (size > 12 && total(size) > bottom - top) size -= 1;
    doc.y = top;
    for (const point of points) bullet(doc, point, margin, width, size, gap(size));
  };

  for (const section of content.sections) {
    const parts = Math.ceil(section.points.length / SLIDE_POINTS);
    for (let i = 0; i < parts; i++) {
      const heading = parts > 1 && i > 0 ? `${section.heading}, continued` : section.heading;
      slide(heading, section.points.slice(i * SLIDE_POINTS, (i + 1) * SLIDE_POINTS), 22);
    }
  }
  const lines = sourceLines(content.sources);
  for (let i = 0; i < lines.length; i += 8) slide(i ? "Sources, continued" : "Sources", lines.slice(i, i + 8), 16);
  footers(doc, 10, margin);
}

// The PDF's bytes, and how many pages it has.
export function renderDocument(content: DocumentContent, created: Date): Promise<{ bytes: Uint8Array; pages: number }> {
  const doc = new PDFDocument({
    size: content.kind === "slides" ? [960, 540] : "LETTER",
    margin: content.kind === "slides" ? 56 : 72,
    bufferPages: true,
    info: { Title: printable(content.title), Subject: printable(content.study), Author: "Transit Agents", Creator: "Transit Agents", CreationDate: created },
    lang: "en-CA",
    displayTitle: true,
  });
  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const ended = new Promise<void>((resolve, reject) => {
    doc.on("end", resolve);
    doc.on("error", reject);
  });
  if (content.kind === "slides") slides(doc, content);
  else report(doc, content);
  const pages = doc.bufferedPageRange().count;
  doc.end();
  return ended.then(() => ({ bytes: new Uint8Array(Buffer.concat(chunks)), pages }));
}
