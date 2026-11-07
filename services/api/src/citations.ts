// Checks a citation against the document it names. This is what stops a figure
// entering a study on the strength of a quote nobody can find, or a real quote
// used to support a different number.

const normalize = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/­/g, "")
    .replace(/(\w)-\s*\n\s*(\w)/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (text: string) => normalize(text).match(/[a-z0-9$%.,()']+/g) ?? [];

const isNumeric = (token: string) => /\d/.test(token);

// Prose must match exactly. Only a table row, which PDF extraction can split
// across columns, may match with gaps, and its words must stay in order.
export type QuoteMatch = "exact" | "table" | "none";

const WINDOW_FACTOR = 4;
const TABLE_MIN_NUMERIC_SHARE = 0.5;

function inOrderWithin(words: string[], wanted: string[]): boolean {
  const size = wanted.length * WINDOW_FACTOR;
  for (let start = 0; start < words.length; start++) {
    if (words[start] !== wanted[0]) continue;
    let next = 1;
    for (let i = start + 1; i < Math.min(words.length, start + size) && next < wanted.length; i++) {
      if (words[i] === wanted[next]) next++;
    }
    if (next === wanted.length) return true;
  }
  return false;
}

export function findQuote(page: string, quote: string, nextPage = ""): QuoteMatch {
  const needle = normalize(quote);
  if (!needle) return "none";
  // A sentence can run onto the next page, but it has to start on the cited one.
  const cited = normalize(page);
  const haystack = normalize(nextPage ? `${page}\n${nextPage}` : page);
  const at = haystack.indexOf(needle);
  if (at !== -1 && at < cited.length) return "exact";

  const wanted = tokens(quote);
  const numeric = wanted.filter(isNumeric).length / (wanted.length || 1);
  if (wanted.length < 3 || numeric < TABLE_MIN_NUMERIC_SHARE) return "none";
  return inOrderWithin(tokens(page), wanted) ? "table" : "none";
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, hundred: 100,
};

// Words that mean a figure is negative: a saving, a loss, a reduction, a minus
// sign, or accounting brackets. A hyphen between two numbers, as in 2026-2027,
// is a range, not a sign.
const NEGATIVE_CUE =
  /\b(decrease[sd]?|reduc(e|ed|es|tion|tions)|saving[s]?|saved|save[sd]?|lose[s]?|lost|loss(es)?|fewer|negative|minus|shorter)\b|\(\s*\$?\d|(?<![\w.])-\s*\$?\d/;

function numbersIn(text: string): number[] {
  const plain = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const digits = [...plain.matchAll(/(?<![\d.])\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  const words = (plain.match(/[a-z]+/g) ?? []).filter((w) => w in NUMBER_WORDS).map((w) => NUMBER_WORDS[w] as number);
  return [...digits, ...words];
}

export type ValueCheck = { ok: true } | { ok: false; reason: string };

// A quote that is mostly numbers is a table row, whether or not it matched exactly.
export const isTableRow = (quote: string) => {
  const words = tokens(quote);
  return words.length >= 3 && words.filter(isNumeric).length / words.length >= TABLE_MIN_NUMERIC_SHARE;
};

// The value must appear in the quote, and its sign must agree with the wording,
// so "a decrease of 610" can back -610 but not 610. A table row's figure must be
// its last cell. That still can't prove which column the cell is in, so a table
// figure is flagged for a reviewer.
export function checkValue(value: number, quote: string, match: QuoteMatch = "exact"): ValueCheck {
  const text = normalize(quote);
  const magnitude = Math.abs(value);
  const numbers = numbersIn(text);
  const same = (n: number) => Math.abs(n - magnitude) < 1e-9;
  const table = match === "table" || isTableRow(quote);

  if (table) {
    // In a table row, the figure is the cell at the end of the quote.
    if (!same(numbers.at(-1) ?? NaN)) return { ok: false, reason: `${value} is not the last cell of the quoted row` };
  } else if (!numbers.some(same)) {
    return { ok: false, reason: `${value} does not appear in the quote` };
  }

  const negativeWording = NEGATIVE_CUE.test(text);
  if (value < 0 && !negativeWording) return { ok: false, reason: `Nothing in the quote says ${magnitude} is negative` };
  if (value > 0 && negativeWording && !table) {
    return { ok: false, reason: `The quote describes a decrease or saving, so ${value} should be negative` };
  }
  return { ok: true };
}
