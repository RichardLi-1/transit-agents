// Search over source pages, so an agent finds the page that mentions something in
// one call, instead of reading a 148-page plan page by page.
//
// The index is derived state, like the fold in state.ts. It lives in memory and is
// never written to the log: the service builds it from its contexts at startup,
// and adds each context it accepts after that.
import { DatabaseSync } from "node:sqlite";
import type { Page } from "./extract.ts";

// Words so common they would match almost every page.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "for", "from", "has", "have", "how", "in", "into",
  "is", "it", "its", "of", "on", "or", "s", "t", "than", "that", "the", "their", "then", "there", "these",
  "they", "this", "to", "was", "were", "what", "when", "where", "which", "who", "will", "with",
]);
const MAX_TERMS = 12;
const MIN_PREFIX = 4;
// A page often goes on with what the page before it named: the page with a
// proposal's figures may never say the proposal's name. So the end of the page
// before also counts toward a page's rank, for less than the page's own text.
const PREVIOUS_CHARS = 1000;
const PREVIOUS_WEIGHT = 0.3;
// Long enough to reach the figure after a page's matched words.
const SNIPPET_TOKENS = 32;

// A query's words, never its syntax: runs of letters and numbers, lowercased,
// without stopwords, at most 12. So quotes, *, -, ^, :, parentheses and NEAR
// reach the index only as the words around them. A number keeps its decimal
// point and thousands commas, so 1,680 and $1.29 each stay one term.
export function searchTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const [word] of query.toLowerCase().matchAll(/\p{N}+(?:[.,]\p{N}+)+|[\p{L}\p{N}]+/gu)) {
    if (!STOPWORDS.has(word)) terms.add(word);
    if (terms.size === MAX_TERMS) break;
  }
  return [...terms];
}

const isNumber = (term: string) => /^[\p{N}.,]+$/u.test(term);

// The index splits 1,680 into 1 and 680, so a number matches as that phrase,
// and only whole: "1"* would match most pages. A word of 4 letters or more is a
// quoted prefix, so "riders" also finds "ridership". A shorter one matches only
// itself, so "car" doesn't find "Carlton". Words are stemmed, so "car" still
// finds "cars".
const phrase = (term: string) => {
  if (isNumber(term)) return `"${term.replace(/[.,]/g, " ")}"`;
  return [...term].length >= MIN_PREFIX ? `"${term}"*` : `"${term}"`;
};

// The end of a page, from the start of a word.
const ending = (text: string) => (text.length > PREVIOUS_CHARS ? text.slice(-PREVIOUS_CHARS).replace(/^\S*\s/, "") : text);

export class SearchIndex {
  private readonly db = new DatabaseSync(":memory:");

  constructor() {
    this.db.exec(
      "CREATE VIRTUAL TABLE pages USING fts5(context_id UNINDEXED, page UNINDEXED, citable UNINDEXED, text, previous, tokenize = 'porter unicode61')",
    );
  }

  // `citable` says whether the source can back a figure, which never changes.
  add(contextId: string, pages: Page[], citable: boolean) {
    const insert = this.db.prepare("INSERT INTO pages (context_id, page, citable, text, previous) VALUES (?, ?, ?, ?, ?)");
    const ordered = pages.toSorted((a, b) => a.page - b.page);
    this.db.exec("BEGIN");
    try {
      ordered.forEach(({ page, text }, i) => insert.run(contextId, page, citable ? 1 : 0, text, ending(ordered[i - 1]?.text ?? "")));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // Pages whose own text has any of the query's terms, best match first by bm25,
  // except that pages a figure can cite come first: an agent's own notes, short
  // and full of its own words, would otherwise crowd them out. The page before
  // only helps a page rank, and never with a number, which has to be on the page
  // itself. The snippet marks matches in [brackets].
  find(query: string, limit: number): { contextId: string; page: number; snippet: string }[] {
    const terms = searchTerms(query);
    if (!terms.length) return [];
    const own = `text : (${terms.map(phrase).join(" OR ")})`;
    const ranked = terms.map((term) => (isNumber(term) ? `text : ${phrase(term)}` : phrase(term))).join(" OR ");
    const rows = this.db
      .prepare(
        `SELECT context_id, page, snippet(pages, 3, '[', ']', '…', ${SNIPPET_TOKENS}) AS snippet FROM pages
         WHERE pages MATCH ? AND rowid IN (SELECT rowid FROM pages WHERE pages MATCH ?)
         ORDER BY citable DESC, bm25(pages, 0, 0, 0, 1, ${PREVIOUS_WEIGHT}), context_id, page LIMIT ?`,
      )
      .all(ranked, own, limit) as { context_id: string; page: number; snippet: string }[];
    return rows.map((row) => ({ contextId: row.context_id, page: row.page, snippet: row.snippet.replace(/\s+/g, " ").trim() }));
  }

  close() {
    this.db.close();
  }
}
