// Agents cite pages as (source-id p. N). In the chat each becomes a button that
// opens the page, so a planner can check a figure where it was quoted.
export type Piece = string | { contextId: string; page: number; text: string };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The text in pieces: plain text, and each "source-id p. N" (or "pp. N") for a
// source the display knows, with the first page it names.
export function withCites(text: string, ids: string[]): Piece[] {
  if (!ids.length) return [text];
  const names = [...ids].sort((a, b) => b.length - a.length).map(escape).join("|");
  const pattern = new RegExp(`(?<![\\w.-])(${names})\\s+pp?\\.\\s*(\\d+)`, "g");
  const pieces: Piece[] = [];
  let at = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > at) pieces.push(text.slice(at, match.index));
    pieces.push({ contextId: match[1] as string, page: Number(match[2]), text: match[0] });
    at = match.index + match[0].length;
  }
  if (at < text.length) pieces.push(text.slice(at));
  return pieces;
}
