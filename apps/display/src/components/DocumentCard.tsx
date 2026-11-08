// A PDF an agent made of the study, in the chat where the log has it: its title,
// whether it's a report or slides, and a link that opens it in a tab of its own.
import type { DocumentItem } from "../store.ts";

export function DocumentCard({ document }: { document: DocumentItem }) {
  const about = `doc-${document.seq}`;
  return (
    <div class="doc-card" data-seq={document.seq}>
      <svg class="doc-icon" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <path d="M7 3.500h7l4 4v13H7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
        <path d="M14 3.500v4h4M10 13h5M10 16h5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
      </svg>
      <p id={about}>
        <span class="doc-title">{document.title}</span>
        <span class="doc-kind">{document.kind === "slides" ? "Slides, PDF" : "Report, PDF"} · Draft, in the study's files</span>
        <span class="doc-edit">Tell me what to change and I'll make a new version.</span>
      </p>
      <a class="doc-open" href={document.url} target="_blank" rel="noopener" aria-describedby={about}>
        Open<span class="sr-only"> in a new tab</span>
      </a>
    </div>
  );
}
