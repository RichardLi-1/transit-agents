// A page's text as pdftotext lays it out, set as a page's paragraphs for a page
// with no image: a paragraph's lines run together, so it wraps at any width, while
// headings, list items and table rows keep lines of their own. Only spacing
// changes, so a quote is found in it as in the page's text.
import { splitAtQuote } from "./quote.ts";

// Wide gaps in a line: a table row, or two columns side by side.
const COLUMNS = /\S {3,}\S/;
// A list item starts a line: a bullet, or a number or letter with a point.
const BULLET = /^([•◦▪‣●○■□►])\s+/;
const ITEM = /^(?:[•◦▪‣●○■□►–—*-]\s|(?:\d{1,2}|[a-z])[.)]\s)/i;
// A line shorter than this share of the page's width ends its paragraph, or is a heading.
const SHORT = 0.75;
// A table row's columns stay apart.
const GAP = "    ";

// Paragraphs apart by a blank line, and a line break wherever a line keeps its own.
export function reflow(text: string): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim().replace(BULLET, "$1 "));
  const prose = lines
    .filter((line) => line && !COLUMNS.test(line))
    .map((line) => line.length)
    .sort((a, b) => a - b);
  // Most of a paragraph's lines run the page's width.
  const width = prose[Math.floor((prose.length - 1) * 0.9)] ?? 0;
  const paragraphs: string[] = [];
  let paragraph = "";
  let previous = "";
  for (const line of lines) {
    if (!line) {
      if (paragraph) paragraphs.push(paragraph);
      paragraph = "";
      continue;
    }
    const columns = COLUMNS.test(line);
    const shown = columns ? line.replace(/ {3,}/g, GAP) : line.replace(/ {2,}/g, " ");
    if (!paragraph) paragraph = shown;
    else if (columns || COLUMNS.test(previous) || ITEM.test(line) || previous.length < width * SHORT) paragraph += `\n${shown}`;
    // A word broken at a hyphen, such as "post-implementation", joins up again.
    else if (/\p{L}-$/u.test(previous) && /^\p{L}/u.test(line)) paragraph += shown;
    else paragraph += ` ${shown}`;
    previous = line;
  }
  if (paragraph) paragraphs.push(paragraph);
  return paragraphs.join("\n\n");
}

// The page's paragraphs, each as its text before the quote, the quote and after. A
// quote that runs from one paragraph into the next is marked in both.
export function paragraphsOf(text: string, quote: string): [string, string, string][] {
  const flowed = reflow(text).normalize("NFKC");
  if (!flowed) return [];
  const [before, quoted] = splitAtQuote(flowed, quote);
  const start = before.length;
  const end = start + quoted.length;
  let at = 0;
  return flowed.split("\n\n").map((paragraph) => {
    const from = Math.min(Math.max(start - at, 0), paragraph.length);
    const to = Math.min(Math.max(end - at, 0), paragraph.length);
    at += paragraph.length + 2;
    return [paragraph.slice(0, from), paragraph.slice(from, to), paragraph.slice(to)];
  });
}
