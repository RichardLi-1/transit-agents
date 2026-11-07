// Prepares the source documents for the demo: the text of every page, for checking
// quotes, and an image of each cited page with the quote's position on it.
//
// Usage: node scripts/build-sources.ts <anp-2026.pdf> <service-standards-2024.pdf>
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RULES, SOURCES, STUDIES } from "../clients/seed-data.ts";

const [planPdf, standardsPdf] = process.argv.slice(2);
if (!planPdf || !standardsPdf) throw new Error("Usage: build-sources.ts <anp-2026.pdf> <service-standards-2024.pdf>");

const root = join(import.meta.dirname, "..");
const FIXTURES = join(root, "clients/fixtures");
const PUBLIC = join(root, "apps/display/public/sources");
const PDFS: Record<string, string> = { "ttc-anp-2026": planPdf, "ttc-standards-2024": standardsPdf };
const DPI = 120;

const text = (args: string[]) => execFileSync("pdftotext", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

for (const source of SOURCES) {
  const pdf = PDFS[source.id];
  if (!pdf) continue;
  const pages = text(["-layout", pdf, "-"])
    .split("\f")
    .map((body, i) => ({ page: i + 1, text: body.trimEnd() }))
    .filter((p) => p.text);
  writeFileSync(join(FIXTURES, `${source.id}.pages.json`), JSON.stringify(pages));
  console.log(source.id, pages.length, "pages");
}

type Citation = { contextId: string; page: number; quote: string };
const citations: Citation[] = [];
const collect = (value: unknown) => {
  if (Array.isArray(value)) value.forEach(collect);
  else if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.contextId === "string" && typeof o.page === "number" && typeof o.quote === "string") citations.push(o as unknown as Citation);
    else Object.values(o).forEach(collect);
  }
};
collect(RULES);
collect(STUDIES);

type Word = { x0: number; y0: number; x1: number; y1: number; word: string };
const clean = (w: string) => w.toLowerCase().replace(/[^a-z0-9$.]/g, "").replace(/\.$/, "");

function wordsOn(pdf: string, page: number) {
  const xml = text(["-bbox", "-f", String(page), "-l", String(page), pdf, "-"]);
  const size = /<page width="([\d.]+)" height="([\d.]+)"/.exec(xml);
  const words: Word[] = [...xml.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)].map((m) => ({
    x0: Number(m[1]),
    y0: Number(m[2]),
    x1: Number(m[3]),
    y1: Number(m[4]),
    word: clean(m[5] as string),
  }));
  return { width: Number(size?.[1]), height: Number(size?.[2]), words };
}

// Finds the first run of words matching the quote.
function locate(words: Word[], quote: string) {
  const wanted = quote.split(/\s+/).map(clean).filter(Boolean);
  for (let start = 0; start < words.length; start++) {
    let i = 0;
    while (i < wanted.length && words[start + i]?.word === wanted[i]) i++;
    if (i === wanted.length) return words.slice(start, start + wanted.length);
  }
  // Table cells come back column by column, so read along the row instead.
  for (const first of words.filter((w) => w.word === wanted[0])) {
    const row = words.filter((w) => Math.abs(w.y0 - first.y0) < 3 && w.x0 >= first.x0).sort((a, b) => a.x0 - b.x0);
    if (wanted.every((word, i) => row[i]?.word === word)) return row.slice(0, wanted.length);
  }
  return undefined;
}

const highlights: Record<string, { page: number; boxes: [number, number, number, number][] }> = {};
const rendered = new Set<string>();
for (const citation of citations) {
  const pdf = PDFS[citation.contextId] as string;
  const directory = join(PUBLIC, citation.contextId);
  mkdirSync(directory, { recursive: true });
  const key = `${citation.contextId}/${citation.page}`;
  if (!rendered.has(key)) {
    rendered.add(key);
    execFileSync("pdftoppm", ["-r", String(DPI), "-f", String(citation.page), "-l", String(citation.page), "-singlefile", "-gray", "-png", pdf, join(directory, `p${citation.page}`)]);
  }
  const { width, height, words } = wordsOn(pdf, citation.page);
  const found = locate(words, citation.quote);
  if (!found) {
    console.warn("No position for quote:", citation.page, citation.quote);
    continue;
  }
  // One box per line of text.
  const lines = new Map<number, Word[]>();
  for (const w of found) {
    const line = Math.round(w.y0);
    lines.set(line, [...(lines.get(line) ?? []), w]);
  }
  const boxes = [...lines.values()].map((line): [number, number, number, number] => {
    const x0 = Math.min(...line.map((w) => w.x0));
    const x1 = Math.max(...line.map((w) => w.x1));
    const y0 = Math.min(...line.map((w) => w.y0));
    const y1 = Math.max(...line.map((w) => w.y1));
    return [x0 / width, y0 / height, (x1 - x0) / width, (y1 - y0) / height];
  });
  highlights[`${citation.contextId}|${citation.page}|${citation.quote}`] = { page: citation.page, boxes };
}
writeFileSync(join(PUBLIC, "highlights.json"), JSON.stringify(highlights));
console.log("citations", citations.length, "pages rendered", rendered.size, "located", Object.keys(highlights).length);
