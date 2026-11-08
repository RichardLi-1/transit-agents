// The quotes the display opens a page at: every one a seed rule, figure, check,
// finding, decision or engagement need cites, and the one a hand-over cites.
// scripts/build-sources.ts gives each page an image, with the quote marked on it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RULES, STUDIES } from "../clients/seed-data.ts";

// A figure's or rule's citation carries its value, so the number can be found too.
export type CitedQuote = { contextId: string; page: number; quote: string; value?: number };

// An agent hands a case to a planner citing the page that leaves it to judgement,
// in the words the handover skill quotes: "the words" (source-id p. N).
const HANDOVER = join(import.meta.dirname, "../agents/skills/handover/SKILL.md");

function handOver(): CitedQuote[] {
  const skill = readFileSync(HANDOVER, "utf8");
  return [...skill.matchAll(/"([^"]+)" \(([a-z0-9-]+) p\. (\d+)\)/g)].map((m) => ({
    contextId: m[2] as string,
    page: Number(m[3]),
    quote: m[1] as string,
  }));
}

// One per quote. A check cites its rule's page too, but without the rule's value.
export function citedQuotes(): CitedQuote[] {
  const found: CitedQuote[] = [];
  const collect = (value: unknown, figure?: number) => {
    if (Array.isArray(value)) value.forEach((item) => collect(item, figure));
    else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (typeof o.contextId === "string" && typeof o.page === "number" && typeof o.quote === "string") {
        found.push({ contextId: o.contextId, page: o.page, quote: o.quote, ...(figure === undefined ? {} : { value: figure }) });
      } else Object.values(o).forEach((item) => collect(item, typeof o.value === "number" ? o.value : figure));
    }
  };
  collect(RULES);
  collect(STUDIES);
  found.push(...handOver());
  const quotes = new Map<string, CitedQuote>();
  for (const citation of found) {
    const key = `${citation.contextId}|${citation.page}|${citation.quote}`;
    if (quotes.get(key)?.value === undefined) quotes.set(key, citation);
  }
  return [...quotes.values()];
}
