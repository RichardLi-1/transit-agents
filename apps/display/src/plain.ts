// Agents are asked for plain text, but a model can still write Markdown. The chat
// shows text as it is, line breaks and all, so the markers that would show as
// symbols go: bold, headings, and list stars, which become bullets.
export function plain(text: string): string {
  return text
    .replace(/\*\*(?=\S)([^*]*?\S)\*\*/g, "$1")
    .replace(/__(?=\S)([^_]*?\S)__/g, "$1")
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, "")
    .replace(/^([ \t]*)[*+][ \t]+/gm, "$1• ");
}
