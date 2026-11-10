// The study's files: every source agents read and cite, by folder, and the drafts
// agents made from them. A file's name opens its first page in Quick Look; a
// source opens where it was published. A file dropped anywhere is added.
import { useEffect, useRef, useState } from "preact/hooks";
import type { Context } from "@transit-agents/contracts";
import type { DocumentItem } from "../store.ts";
import { api } from "../api.ts";
import { webUrl } from "../host.ts";
import { LineIcon } from "./icons.tsx";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What a page is about, from its first line that reads as words: a document's title.
export function aboutOf(text: string | undefined): string | null {
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.replace(/[^\p{L}\p{N}&,.'()\-– ]+/gu, " ").replace(/\s+/g, " ").trim();
    if ((line.match(/\p{L}/gu) ?? []).length >= 10) return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  }
  return null;
}

// What a new file says as it's taken in, beside the Add button.
async function upload(file: File, say: (text: string | null) => void) {
  const form = new FormData();
  form.set("file", file);
  const response = await api("/v1/context", { method: "POST", body: form });
  if (!response.ok) return;
  const context = (await response.json()) as { id: string; title: string; pageCount?: number };
  const pages = context.pageCount ?? 0;
  say(`Indexing ${context.title}…`);
  await wait(900);
  say(`Indexed ${pages} ${pages === 1 ? "page" : "pages"}. Understanding it…`);
  const about = await api(`/v1/context/${encodeURIComponent(context.id)}/pages/1`)
    .then((r) => (r.ok ? (r.json() as Promise<{ text?: string }>) : null))
    .then((page) => aboutOf(page?.text))
    .catch(() => null);
  await wait(900);
  say(`${about ? `About: ${about}. ` : ""}Every agent can now find and cite it.`);
  await wait(7000);
  say(null);
}

// A source's kind: a PDF, or an open data set.
const kindOf = (context: Context) => (/\.pdf(\?|$)/i.test(context.url ?? "") ? "PDF" : context.folder === "Inbox" ? "File" : "Open data");

const added = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "short", day: "numeric" });
const number = new Intl.NumberFormat("en-CA");

type Props = {
  contexts: Context[];
  drafts: DocumentItem[];
  reading: string | null;
  canAdd: boolean;
  onOpen: (context: Context, element: Element) => void;
};

export function Files({ contexts, drafts, reading, canAdd, onOpen }: Props) {
  const [dragging, setDragging] = useState(false);
  const [said, say] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // Dropped anywhere on the page, as the folder bar took them.
  useEffect(() => {
    if (!canAdd) return;
    let depth = 0;
    const enter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const over = (event: DragEvent) => event.preventDefault();
    const leave = () => {
      depth -= 1;
      if (depth <= 0) setDragging(false);
    };
    const drop = (event: DragEvent) => {
      event.preventDefault();
      depth = 0;
      setDragging(false);
      for (const file of event.dataTransfer?.files ?? []) void upload(file, say);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [canAdd]);

  const folders = new Map<string, Context[]>();
  for (const context of contexts) folders.set(context.folder, [...(folders.get(context.folder) ?? []), context]);

  return (
    <div class={dragging ? "files dragging" : "files"}>
      <div class="files-bar">
        <p class="count">{`${number.format(contexts.length)} ${contexts.length === 1 ? "source" : "sources"}${drafts.length ? ` · ${drafts.length} ${drafts.length === 1 ? "draft" : "drafts"}` : ""}`}</p>
        <p class="said" role="status">
          {said}
        </p>
        {canAdd && (
          <>
            <button type="button" class="add" onClick={() => input.current?.click()}>
              <LineIcon name="plus" size={18} />
              Add
            </button>
            <input
              ref={input}
              class="sr-only"
              type="file"
              multiple
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const target = event.currentTarget;
                for (const file of target.files ?? []) void upload(file, say);
                target.value = "";
              }}
            />
          </>
        )}
      </div>
      <div class="table-scroll" tabIndex={0} role="region" aria-label="Files table">
        <table class="file-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Kind</th>
              <th scope="col" class="num">
                Pages
              </th>
              <th scope="col">Added</th>
              <th scope="col">
                <span class="sr-only">Source</span>
              </th>
            </tr>
          </thead>
          {[...folders].map(([folder, items]) => (
            <tbody key={folder} data-folder={folder}>
              <tr class="group">
                <th scope="colgroup" colSpan={5}>
                  <LineIcon name="files" size={16} />
                  {folder}
                  <span class="n">{items.length}</span>
                </th>
              </tr>
              {items.map((context) => {
                const url = webUrl(context.url);
                const busy = context.id === reading;
                return (
                  <tr key={context.id} data-folder={context.id} class={busy ? "reading" : undefined}>
                    <th scope="row">
                      <button type="button" class="file-name" onClick={(event) => onOpen(context, event.currentTarget)}>
                        <span class="title">{context.title}</span>
                        <span class="sr-only">, Quick Look</span>
                      </button>
                      {busy && <span class="busy">Reading</span>}
                    </th>
                    <td>{kindOf(context)}</td>
                    <td class="num">{context.pageCount ? number.format(context.pageCount) : "–"}</td>
                    <td>{added.format(Date.parse(context.addedAt))}</td>
                    <td>
                      {url && (
                        <a class="icon-link" href={url} target="_blank" rel="noopener noreferrer" aria-label={`${context.title}, opens source`}>
                          <LineIcon name="open" size={18} />
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
          {drafts.length > 0 && (
            // The study's drafts, which agents made from the sources: kept beside them to
            // open and edit, but never a source themselves, so no agent cites its own work.
            <tbody data-folder="drafts">
              <tr class="group">
                <th scope="colgroup" colSpan={5}>
                  <LineIcon name="study" size={16} />
                  Drafts
                  <span class="n">{drafts.length}</span>
                </th>
              </tr>
              {drafts.map((draft) => (
                <tr key={draft.seq} class="draft">
                  <th scope="row">
                    <a class="file-name" href={draft.url} target="_blank" rel="noopener">
                      <span class="title">{draft.title}</span>
                      <span class="sr-only">, opens the PDF in a new tab</span>
                    </a>
                  </th>
                  <td>{draft.kind === "slides" ? "Slides" : "Report"}</td>
                  <td class="num">–</td>
                  <td>Draft</td>
                  <td />
                </tr>
              ))}
            </tbody>
          )}
        </table>
      </div>
    </div>
  );
}
