import { useEffect, useRef, useState } from "preact/hooks";
import type { Context } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { webUrl } from "../host.ts";
import { FileIcon, FolderIcon, PlusIcon } from "./icons.tsx";

async function upload(file: File) {
  const form = new FormData();
  form.set("file", file);
  await api("/v1/context", { method: "POST", body: form });
}

const extension = (title: string) => /\.(\w{1,4})$/.exec(title)?.[1]?.toUpperCase() ?? "";

type Props = { contexts: Context[]; reading: string | null; highlight: string | null; canAdd: boolean };

export function Shelf({ contexts, reading, highlight, canAdd }: Props) {
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

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
      for (const file of event.dataTransfer?.files ?? []) void upload(file);
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
    <nav class={`shelf${dragging ? " dragging" : ""}`} aria-label="Context">
      <ul>
        {[...folders].map(([name, items]) => {
          const isReading = items.some((c) => c.id === reading) || name === highlight;
          const first = items[0];
          return (
            <li key={name} data-folder={name} class={isReading ? "item reading" : "item"}>
              <a href={webUrl(first?.url) ?? "#"} target="_blank" rel="noopener noreferrer" aria-label={`${name}, ${items.length} ${items.length === 1 ? "item" : "items"}, opens source`}>
                <FolderIcon />
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
        {canAdd && (
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
                for (const file of target.files ?? []) void upload(file);
                target.value = "";
              }}
            />
          </li>
        )}
      </ul>
    </nav>
  );
}
