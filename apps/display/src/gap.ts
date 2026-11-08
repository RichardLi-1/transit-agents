// A note that records a gap, as agents/skills/handover sets out: what's missing,
// then the next step, then who to contact. The card shows what's missing as the
// note, with the step and the contact on a smaller line under it.
export type Gap = { missing: string; next: string; contact: string };

const GAP = /^(.+?[.?!]) Next: (.+?)\. Contact: (.+?)\.?$/;

// The note's parts, or null for a note that isn't a gap.
export function gap(text: string): Gap | null {
  const match = GAP.exec(text.trim());
  if (!match) return null;
  const [, missing = "", next = "", contact = ""] = match;
  return { missing, next, contact };
}
