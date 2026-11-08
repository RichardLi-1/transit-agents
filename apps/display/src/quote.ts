// Finds a cited quote in a page's text, to mark it where the page has no image.
// Like the service's check, it ignores case, spacing and line breaks, and treats
// curly and straight quotes, and every dash, as the same.

const SINGLE = "'‘’‚‛";
const DOUBLE = '"“”„‟';
const DASHES = "-‐‑‒–—―−";

const pattern = (char: string) => {
  if (SINGLE.includes(char)) return `[${SINGLE}]`;
  if (DOUBLE.includes(char)) return `[${DOUBLE}]`;
  if (DASHES.includes(char)) return `[${DASHES}]`;
  return char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
};

// The page's text in three parts: before the quote, the quote as the page has it,
// and after. Without the quote, all of it is before. Ligatures such as "ﬁ" become
// plain letters, as the service reads them.
export function splitAtQuote(text: string, quote: string): [string, string, string] {
  const page = text.normalize("NFKC");
  const words = quote.normalize("NFKC").trim().split(/\s+/).filter(Boolean);
  const match = words.length ? new RegExp(words.map((word) => [...word].map(pattern).join("")).join("\\s+"), "iu").exec(page) : null;
  if (!match) return [page, "", ""];
  const end = match.index + match[0].length;
  return [page.slice(0, match.index), match[0], page.slice(end)];
}
