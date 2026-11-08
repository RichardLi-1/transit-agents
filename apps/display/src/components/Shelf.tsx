import { useEffect, useRef, useState } from "preact/hooks";
import type { Context } from "@transit-agents/contracts";
import type { DocumentItem } from "../store.ts";
import { api } from "../api.ts";
import { webUrl } from "../host.ts";
import { DocumentIcon, FileIcon, FolderIcon, PlusIcon } from "./icons.tsx";

// What a new file says as it's taken in, in a bubble under it on the shelf.
type Bubble = { id: string; text: string };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// What a page is about, from its first line that reads as words: a document's title.
export function aboutOf(text: string | undefined): string | null {
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.replace(/[^\p{L}\p{N}&,.'()\-– ]+/gu, " ").replace(/\s+/g, " ").trim();
    if ((line.match(/\p{L}/gu) ?? []).length >= 10) return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
  }
  return null;
}

async function upload(file: File, say: (bubble: Bubble | null) => void) {
  const form = new FormData();
  form.set("file", file);
  const response = await api("/v1/context", { method: "POST", body: form });
  if (!response.ok) return;
  const context = (await response.json()) as { id: string; title: string; pageCount?: number };
  const pages = context.pageCount ?? 0;
  say({ id: context.id, text: `Indexing ${context.title}…` });
  await wait(900);
  say({ id: context.id, text: `Indexed ${pages} ${pages === 1 ? "page" : "pages"}. Understanding it…` });
  const about = await api(`/v1/context/${encodeURIComponent(context.id)}/pages/1`)
    .then((r) => (r.ok ? (r.json() as Promise<{ text?: string }>) : null))
    .then((page) => aboutOf(page?.text))
    .catch(() => null);
  await wait(900);
  say({ id: context.id, text: `${about ? `About: ${about}. ` : ""}Every agent can now find and cite it.` });
  await wait(7000);
  say(null);
}

const extension = (title: string) => /\.(\w{1,4})$/.exec(title)?.[1]?.toUpperCase() ?? "";

// A one-document source's kind and band: a PDF's red, or an open data set's green.
const kind = (context: Context | undefined) =>
  context && /\.pdf(\?|$)/i.test(context.url ?? "") ? { name: "PDF", color: "#d93a32" } : { name: "open data", color: "#2f8f5b" };

// With no folders yet, how long to wait for them before showing the add button
// on its own. Shown before they arrive, it would jump along the shelf as they do.
const FOLDERS_WAIT_MS = 2000;

type Props = { contexts: Context[]; drafts?: DocumentItem[]; reading: string | null; highlight: string | null; canAdd: boolean };

// A draft's short name for the shelf: its title up to the colon, "TPAP brief".
const shortTitle = (title: string) => title.split(":")[0]?.trim() || title;

export function Shelf({ contexts, drafts = [], reading, highlight, canAdd }: Props) {
  const [dragging, setDragging] = useState(false);
  const [waited, setWaited] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const nav = useRef<HTMLElement>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);
  const [bubbleAt, setBubbleAt] = useState<number | null>(null);
  // Under the new file once the shelf shows it; until then, under the add button.
  useEffect(() => {
    if (!bubble || !nav.current) return setBubbleAt(null);
    const shelf = nav.current.getBoundingClientRect();
    const item = nav.current.querySelector(`li[data-folder="${CSS.escape(bubble.id)}"]`) ?? nav.current.querySelector("li:has(> .add)");
    const at = item?.getBoundingClientRect();
    setBubbleAt(at ? at.left + at.width / 2 - shelf.left : null);
  }, [bubble, contexts.length]);
  const say = (next: Bubble | null) => setBubble(next);

  useEffect(() => {
    const timer = window.setTimeout(() => setWaited(true), FOLDERS_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, []);

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
  const loose: Context[] = [];
  for (const context of contexts) {
    if (context.folder === "Inbox") loose.push(context);
    else folders.set(context.folder, [...(folders.get(context.folder) ?? []), context]);
  }

  return (
    <nav ref={nav} class={`shelf${dragging ? " dragging" : ""}`} aria-label="Context">
      <ul>
        {[...folders].map(([name, items]) => {
          const isReading = items.some((c) => c.id === reading) || name === highlight;
          const first = items[0];
          return (
            <li key={name} data-folder={name} class={isReading ? "item reading" : "item"}>
              <a
                href={webUrl(first?.url) ?? "#"}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${name}, ${items.length > 1 ? `${items.length} items` : kind(first).name}, opens source`}
              >
                {/* A folder only where it holds several documents; one document shows as itself. */}
                {items.length > 1 ? <FolderIcon /> : <DocumentIcon color={kind(first).color} />}
                <span>{name}</span>
              </a>
            </li>
          );
        })}
        {loose.map((context) => (
          <li key={context.id} data-folder={context.id} class={context.id === reading ? "item reading" : "item"}>
            <span class="file">
              <FileIcon label={extension(context.title)} />
              <span>{context.title}</span>
            </span>
          </li>
        ))}
        {/* The study's drafts, which agents made from the sources: kept beside them to
            open and edit, but never a source themselves, so no agent cites its own work. */}
        {drafts.map((draft) => (
          <li key={`draft-${draft.seq}`} data-folder={`draft-${draft.seq}`} class="item draft">
            <a href={draft.url} target="_blank" rel="noopener">
              <span class="draft-icon">
                <DocumentIcon color="#b03488" />
                <span class="draft-tag">Draft</span>
              </span>
              <span>
                {shortTitle(draft.title)}
                <span class="sr-only">
                  : {draft.title}, {draft.kind === "slides" ? "slides" : "a report"} you can ask to change. Opens the PDF in a new tab
                </span>
              </span>
            </a>
          </li>
        ))}
        {/* With the folders, not ahead of them: they would push it along as they arrive.
            A file can be dropped anywhere before then. */}
        {canAdd && (contexts.length > 0 || waited) && (
          <li class="item">
            <button type="button" class="add" aria-label="Add context" onClick={() => input.current?.click()}>
              <PlusIcon />
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
          </li>
        )}
      </ul>
      <p class="shelf-bubble" role="status" hidden={!bubble} style={bubbleAt === null ? undefined : { left: `${bubbleAt}px` }}>
        {bubble?.text}
      </p>
    </nav>
  );
}
