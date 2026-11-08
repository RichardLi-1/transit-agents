import { useEffect, useRef, useState } from "preact/hooks";
import type { Context } from "@transit-agents/contracts";
import { recordedBy } from "../actors.ts";
import { api } from "../api.ts";
import { amount, quantity, unitAfter } from "../figures.ts";
import { webUrl } from "../host.ts";
import { paragraphsOf } from "../reflow.ts";

export type OpenedSource = { label: string; value?: number; unit?: string; contextId: string; page: number; quote: string };

export type Opened = {
  title: string;
  value?: number;
  unit?: string;
  // Who recorded the figure, as the log names them.
  by?: string;
  // With the inputs' values in place of their names.
  formula?: string | undefined;
  sources: OpenedSource[];
  // Values a planner set, which have no page to open, with why and who set them.
  steps: { label: string; value: number; unit: string; reason?: string; owner?: string }[];
  // Over the sources: why something was proposed, and why it failed.
  note?: string;
  alert?: string;
  // One thing a planner can do here, such as ask for a need to be made.
  action?: { label: string; name: string; run: () => void };
};

type Box = [number, number, number, number];
// The quote's lines, and the figure's own number among them.
type Marks = { boxes: Box[]; cell?: Box };
type Highlights = Record<string, Marks>;

const place = ([x, y, w, h]: Box) => ({ left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` });

const THREAD_MS = 750;

let highlights: Promise<Highlights> | undefined;
const loadHighlights = () => (highlights ??= fetch("/sources/highlights.json").then((r) => r.json() as Promise<Highlights>));

type Props = { opened: Opened | null; contexts: Context[]; onClose: () => void };

export function QuickLook({ opened, contexts, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(0);
  const [marks, setMarks] = useState<Marks>({ boxes: [] });
  // Every page the seed cites has an image. Any other page an agent cites shows
  // its text, set as a page, with the quote marked.
  const [failed, setFailed] = useState<string | null>(null);
  const [text, setText] = useState<{ page: string; text: string } | null>(null);
  // The page whose image has loaded, and the highlight to bring into view on it:
  // the figure's own number, or else the quote's first line.
  const [loaded, setLoaded] = useState<string | null>(null);
  const first = useRef<HTMLSpanElement>(null);
  // Nothing scrolls until the dialog shows, which can be after the image loads.
  const [shown, setShown] = useState(false);

  // The thread to the source folder draws first, then the page opens over it.
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    setIndex(0);
    if (!opened) {
      if (element.open) element.close();
      setShown(false);
      return;
    }
    const wait = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : THREAD_MS;
    const timer = window.setTimeout(() => {
      if (!element.open) element.showModal();
      setShown(true);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [opened]);

  const source = opened?.sources[index];
  const page = source ? `${source.contextId}/${source.page}` : null;
  const missing = page !== null && failed === page;
  const url = webUrl(source && contexts.find((c) => c.id === source.contextId)?.url);

  useEffect(() => {
    if (!source) return;
    let live = true;
    void loadHighlights().then((all) => {
      if (live) setMarks(all[`${source.contextId}|${source.page}|${source.quote}`] ?? { boxes: [] });
    });
    return () => {
      live = false;
    };
  }, [source]);

  // A cited number can sit low on a tall page, below the sheet's edge, so the
  // sheet scrolls to it once the image has its height.
  useEffect(() => {
    if (!shown || !page || loaded !== page) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // After the frame that lays the new page out.
    const frame = requestAnimationFrame(() => first.current?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" }));
    return () => cancelAnimationFrame(frame);
  }, [marks, loaded, page, shown]);

  useEffect(() => {
    if (!source || !page || !missing) return;
    let live = true;
    void api(`/v1/context/${encodeURIComponent(source.contextId)}/pages/${source.page}`)
      .then((response) => (response.ok ? (response.json() as Promise<{ text: string }>) : { text: "" }))
      .catch(() => ({ text: "" }))
      .then((read) => {
        if (live) setText({ page, text: read.text });
      });
    return () => {
      live = false;
    };
  }, [source, page, missing]);

  return (
    <dialog ref={dialog} class="quicklook" aria-label={opened?.title ?? "Source"} onClose={onClose} onClick={(event) => event.target === dialog.current && onClose()}>
      {opened && (
        <div class="sheet">
          <header>
            <h2>
              {opened.title}
              {opened.value !== undefined && <span class="value"> {amount({ value: opened.value, unit: opened.unit ?? "" })}</span>}
              {opened.value !== undefined && unitAfter(opened.unit ?? "") && <span class="unit"> {unitAfter(opened.unit ?? "")}</span>}
            </h2>
            <button type="button" class="close" aria-label="Close" onClick={onClose}>
              ×
            </button>
          </header>
          {opened.by && <p class="by">{recordedBy(opened.by)}</p>}
          {opened.formula && <p class="formula">= {opened.formula}</p>}
          {opened.steps.length > 0 && (
            <ul class="steps">
              {opened.steps.map((step) => (
                <li key={step.label}>
                  <span>
                    {step.label} <strong>{quantity(step.value, step.unit)}</strong>
                  </span>
                  {(step.reason || step.owner) && (
                    <span class="why">
                      {[step.reason, step.owner && recordedBy(step.owner)].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {opened.note && <p class="note">{opened.note}</p>}
          {opened.alert && <p class="note alert">{opened.alert}</p>}
          {opened.action && (
            <button
              type="button"
              class="act"
              aria-label={opened.action.name}
              onClick={() => {
                opened.action?.run();
                onClose();
              }}
            >
              {opened.action.label}
            </button>
          )}
          {opened.sources.length > 1 && (
            <div class="tabs">
              {opened.sources.map((s, i) => (
                <button key={`${s.label}-${i}`} type="button" aria-pressed={i === index} onClick={() => setIndex(i)}>
                  {s.label}
                  {s.value !== undefined && <span> {quantity(s.value, s.unit ?? "")}</span>}
                </button>
              ))}
            </div>
          )}
          {source && (
            <figure>
              {missing ? (
                <PageText text={text?.page === page ? text.text : null} quote={source.quote} page={source.page} />
              ) : (
                <div class="page">
                  <img
                    src={`/sources/${source.contextId}/p${source.page}.webp`}
                    alt={source.quote ? `Page ${source.page}. Highlighted text: ${source.quote}` : `Page ${source.page} of ${source.label}`}
                    width="1020"
                    height="1320"
                    onLoad={() => setLoaded(page)}
                    onError={() => setFailed(page)}
                  />
                  {marks.boxes.map((box, i) => (
                    <span key={`${box[0]}-${box[1]}`} ref={i === 0 && !marks.cell ? first : undefined} class="mark" style={place(box)} />
                  ))}
                  {marks.cell && <span ref={first} class="mark cell" style={place(marks.cell)} />}
                </div>
              )}
              {/* Page numbers count the PDF's pages, which can differ from those printed on them. */}
              <figcaption>
                {url ? (
                  <a href={`${url}#page=${source.page}`} target="_blank" rel="noopener noreferrer">
                    PDF page {source.page}
                  </a>
                ) : (
                  `PDF page ${source.page}`
                )}
              </figcaption>
            </figure>
          )}
        </div>
      )}
    </dialog>
  );
}

// A page with no image: its text on a sheet of paper, in paragraphs, with its
// number at the foot and the quote marked, scrolled into view.
function PageText({ text, quote, page }: { text: string | null; quote: string; page: number }) {
  const mark = useRef<HTMLElement>(null);
  useEffect(() => mark.current?.scrollIntoView({ block: "center" }), [text, quote]);
  const paragraphs = text ? paragraphsOf(text, quote) : [];
  const first = paragraphs.findIndex(([, quoted]) => quoted);
  return (
    <article class="paper" aria-label={`Text of page ${page}`} aria-busy={text === null ? "true" : undefined}>
      {paragraphs.map(([before, quoted, after], i) => (
        <p key={i}>
          {before}
          {quoted && <mark ref={i === first ? mark : undefined}>{quoted}</mark>}
          {after}
        </p>
      ))}
      {text !== null && !paragraphs.length && <p class="none">No text to show for this page.</p>}
      <footer>{page}</footer>
    </article>
  );
}
