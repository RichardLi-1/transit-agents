import { useEffect, useRef, useState } from "preact/hooks";

export type OpenedSource = { label: string; value?: number; unit?: string; contextId: string; page: number; quote: string };

export type Opened = {
  title: string;
  value?: number;
  unit?: string;
  formula?: string | undefined;
  sources: OpenedSource[];
  steps: { label: string; value: number }[];
};

type Highlights = Record<string, { boxes: [number, number, number, number][] }>;

const number = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 });

const THREAD_MS = 750;

let highlights: Promise<Highlights> | undefined;
const loadHighlights = () => (highlights ??= fetch("/sources/highlights.json").then((r) => r.json() as Promise<Highlights>));

export function QuickLook({ opened, onClose }: { opened: Opened | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const [boxes, setBoxes] = useState<[number, number, number, number][]>([]);

  // The thread to the source folder draws first, then the page opens over it.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    setIndex(0);
    if (!opened) {
      if (element.open) element.close();
      return;
    }
    const wait = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : THREAD_MS;
    const timer = window.setTimeout(() => {
      if (!element.open) element.showModal();
    }, wait);
    return () => window.clearTimeout(timer);
  }, [opened]);

  const source = opened?.sources[index];

  useEffect(() => {
    if (!source) return;
    let live = true;
    void loadHighlights().then((all) => {
      if (live) setBoxes(all[`${source.contextId}|${source.page}|${source.quote}`]?.boxes ?? []);
    });
    return () => {
      live = false;
    };
  }, [source]);

  return (
    <dialog ref={dialog} class="quicklook" aria-label={opened?.title ?? "Source"} onClose={onClose} onClick={(event) => event.target === dialog.current && onClose()}>
      {opened && (
        <div class="sheet">
          <header>
            <h2>
              {opened.title}
              {opened.value !== undefined && <span class="value"> {number.format(Math.abs(opened.value))}</span>}
            </h2>
            <button type="button" class="close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </header>
          {opened.sources.length > 1 && (
            <div class="tabs">
              {opened.sources.map((s, i) => (
                <button key={`${s.label}-${i}`} type="button" aria-pressed={i === index} onClick={() => setIndex(i)}>
                  {s.label}
                  {s.value !== undefined && <span> {number.format(Math.abs(s.value))}</span>}
                </button>
              ))}
            </div>
          )}
          {source && (
            <figure>
              <div class="page">
                <img src={`/sources/${source.contextId}/p${source.page}.png`} alt={`Page ${source.page}. Highlighted text: ${source.quote}`} width="1020" height="1320" />
                {boxes.map(([x, y, w, h]) => (
                  <span key={`${x}-${y}`} class="mark" style={{ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` }} />
                ))}
              </div>
              <figcaption>p. {source.page}</figcaption>
            </figure>
          )}
        </div>
      )}
    </dialog>
  );
}
