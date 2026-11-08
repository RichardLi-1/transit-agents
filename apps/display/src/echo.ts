// Once the lead has made a document it answers in one line, "Document ready:
// <title>. <link>", for Slack and other clients. In the chat, the document's own
// card already says that, with an Open button, so the line would only add a long
// address. The chat shows the card alone.
const READY = /^Document ready\b/;

export function echoesDocument(text: string, urls: readonly string[]): boolean {
  if (!READY.test(text)) return false;
  return urls.some((url) => {
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    return path.length > 1 && text.includes(path);
  });
}
