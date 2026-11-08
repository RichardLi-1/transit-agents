// Agents are asked for plain text, but a model can still write Markdown. The chat
// shows text as it is, line breaks and all, so the markers that would show as
// symbols go: bold, headings, and list stars, which become bullets.
// As plain, but keeping **bold**, for a whole answer shown at rest: the chat draws it bold.
export function plainBold(text: string): string {
  return plain(text.replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "\u0001$1\u0002")).replace(/\u0001/g, "**").replace(/\u0002/g, "**");
}

export function plain(text: string): string {
  return text
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([^_]*?\S)__/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1• ");
}
