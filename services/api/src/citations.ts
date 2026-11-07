// Checks a citation against the document it names. This is what stops a figure
// entering a study on the strength of a quote nobody can find.

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

const tokens = (text: string) => normalize(text).match(/[a-z0-9$%.,']+/g) ?? [];

export type QuoteMatch = "exact" | "scattered" | "none";

// PDF text extraction reorders tables, so a row can come back with its cells
// apart. A quote counts as scattered when every one of its words sits inside a
// short stretch of the page, in any order.
const WINDOW_FACTOR = 4;

export function findQuote(page: string, quote: string): QuoteMatch {
  const haystack = normalize(page);
  const needle = normalize(quote);
  if (!needle) return "none";
  if (haystack.includes(needle)) return "exact";

  const wanted = tokens(quote);
  const words = tokens(page);
  if (wanted.length < 3) return "none";
  const size = wanted.length * WINDOW_FACTOR;
  for (let start = 0; start <= Math.max(words.length - 1, 0); start += 1) {
    const window = words.slice(start, start + size);
    const left = [...wanted];
    for (const word of window) {
      const at = left.indexOf(word);
      if (at !== -1) left.splice(at, 1);
      if (!left.length) return "scattered";
    }
  }
  return "none";
}

// The value must literally appear in the quote, so a figure can't borrow a
// genuine quote while reporting a different number. Signs are ignored because
// documents say "a decrease of 610" where the figure says -610.
export function valueInQuote(value: number, quote: string): boolean {
  const text = normalize(quote).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const magnitude = Math.abs(value);
  const forms = new Set([String(magnitude), magnitude.toFixed(2), magnitude.toFixed(1)]);
  return [...forms].some((form) => {
    const escaped = form.replace(".", "\\.");
    return new RegExp(`(?<![\\d.])${escaped}(?![\\d]|\\.\\d)`).test(text);
  });
}
