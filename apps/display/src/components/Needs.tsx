// What people near a change need to see, floating over the place each is for. An
// agent proposes it; only a planner asks for it to be made. Then an agent makes
// the image or video, and it shows here, labelled as illustrative.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { MediaView, NeedStatus, NeedView, StudyView } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { projector, toPoint, type ViewFeed } from "../map/projection.ts";
import { stillOf, type Still } from "../still.ts";
import { AlertIcon, ImageIcon, PlayIcon, VideoIcon } from "./icons.tsx";
import type { Opened as Details, OpenedSource } from "./QuickLook.tsx";

// The models' names as people know them.
const MODELS: Record<string, string> = { "gemini-3.1-flash-image": "Nano Banana 2", "gemini-omni-1.2-flash": "Omni Flash" };

// What a file drew on, as pages to open: cited pages, and the page each figure cites.
function sourcesOf(media: MediaView, study: StudyView | null): OpenedSource[] {
  return media.inputs.flatMap((input): OpenedSource[] => {
    if ("citation" in input) return [{ label: `p. ${input.citation.page}`, ...input.citation }];
    const figure = study?.figures.find((f) => f.id === input.figure);
    return figure?.basis.kind === "cited" ? [{ label: figure.label, value: figure.value, unit: figure.unit, ...figure.basis.citation }] : [];
  });
}

const pagesOf = (sources: OpenedSource[]) => {
  const pages = [...new Set(sources.map((source) => source.page))];
  return `p. ${pages.slice(0, -1).join(", ")}${pages.length > 1 ? " and " : ""}${pages.at(-1)}`;
};

// Each kind in words: "image", "video", or "image and video".
const kindsIn = (kinds: readonly string[]) => kinds.join(" and ");
const article = (kinds: readonly string[]) => kinds.map((kind) => (kind === "image" ? "an image" : "a video")).join(" and ");

// What the card says about a need, in the words of what it is for.
function stateOf(need: NeedView, status: NeedStatus): string {
  if (status === "needed") return "Needed for public engagement";
  if (status === "failed") return "Couldn't be made";
  if (status === "ready") return "Illustrative, for public engagement";
  // Asked for here, a need still shows its last request's claim until the log's echo.
  return need.status === "creating" && need.claimedAt ? `Making the ${kindsIn(missing(need))}…` : "Waiting for an agent";
}

// Room between a card and its place, and between a card and the map's edges.
const GAP = 16;
const EDGE = 8;

type Size = [number, number];
type Opened = { need: NeedView; media: MediaView; size: Size | null; poster: string | undefined; from: HTMLElement };

const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// The newest file of each kind.
const latest = (need: NeedView) => (["image", "video"] as const).flatMap((kind) => need.media.filter((m) => m.kind === kind).slice(-1));

// The kinds it asks for that no file has yet.
const missing = (need: NeedView) => need.kinds.filter((kind) => !need.media.some((m) => m.kind === kind));

// A planner can ask for a need that hasn't been made, or whose last request failed.
const creatable = (status: NeedStatus) => status === "needed" || status === "failed";

// A need as the log last told it. Asked for here, it shows as creating until the
// log's echo changes it, and then shows whatever the log says, a later failure too.
const version = (need: NeedView) => `${need.status} ${need.failedAt ?? ""}`;

const actionOf = (status: NeedStatus) => (status === "failed" ? "Try again" : "Create");

// The panels over the map, in the cards' coordinates: the study card and the time
// bar. A place under one can't be pointed at, and a card keeps off them.
function panels(list: HTMLElement): DOMRect[] {
  const origin = list.getBoundingClientRect();
  return [...document.querySelectorAll<HTMLElement>(".stage > .card, .stage > .time")]
    .map((panel) => panel.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => new DOMRect(rect.left - origin.left, rect.top - origin.top, rect.width, rect.height));
}

const covers = (rect: DOMRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
const overlap = (a: DOMRect, b: DOMRect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

// How long to wait for the map before listing the cards without it.
const MAP_WAIT_MS = 3000;

// Keeps each card over its place while the camera moves. A card whose place is off
// the map or under a panel, or every card while the map hasn't drawn, is listed at
// the map's top left instead, so it's never hidden. Cards move only by transform,
// so nothing on the page shifts.
function useFollow(feed: ViewFeed, list: { current: HTMLUListElement | null }, needs: NeedView[]) {
  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return;
    let frame = 0;
    let waited = false;
    const place = () => {
      const view = feed.view;
      if (!view && !waited) return;
      const project = view ? projector(view) : null;
      const width = view?.width ?? element.clientWidth;
      const height = view?.height ?? element.clientHeight;
      // Cards keep clear of the panels along the top and the side of the map.
      const style = getComputedStyle(element);
      const top = parseFloat(style.getPropertyValue("--map-top")) || EDGE;
      const right = width - (parseFloat(style.getPropertyValue("--map-right")) || 0) - EDGE;
      const over = panels(element);
      let listed = top;
      for (const pin of element.querySelectorAll<HTMLElement>(".pin")) {
        const card = pin.querySelector<HTMLElement>(".need");
        if (!card) continue;
        const at = project?.(toPoint(Number(pin.dataset.lat), Number(pin.dataset.lon))) ?? null;
        const cardWidth = card.offsetWidth;
        const cardHeight = card.offsetHeight;
        pin.style.visibility = "visible";
        const shown = at && at[0] >= 0 && at[0] <= width && at[1] >= 0 && at[1] <= height && !over.some((rect) => covers(rect, at[0], at[1]));
        const [x, y] = at ?? [0, 0];
        const below = y - GAP - cardHeight < top;
        const cardTop = below ? y + GAP : y - GAP - cardHeight;
        let left = Math.max(EDGE, Math.min(x - cardWidth / 2, right - cardWidth));
        // Beside a panel it would cover, never under it.
        for (const rect of over) {
          if (overlap(new DOMRect(left, cardTop, cardWidth, cardHeight), rect)) left = Math.max(EDGE, Math.min(rect.right + EDGE, right - cardWidth));
        }
        if (!shown || over.some((rect) => overlap(new DOMRect(left, cardTop, cardWidth, cardHeight), rect))) {
          pin.dataset.side = "listed";
          pin.style.transform = `translate(${EDGE * 3}px, ${listed}px)`;
          card.style.transform = "translate(0, 0)";
          listed += cardHeight + EDGE;
          continue;
        }
        pin.dataset.side = below ? "below" : "above";
        pin.style.transform = `translate(${x}px, ${y}px)`;
        card.style.transform = `translate(${left - x}px, ${cardTop - y}px)`;
      }
    };
    const later = () => {
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    };
    // At once when the camera reports: the map reports a frame ahead of drawing it,
    // so the cards and the map show each frame together.
    const stop = feed.subscribe(place);
    // A map that never draws, as when its data fails to load, still shows the cards.
    const timer = window.setTimeout(() => {
      waited = true;
      later();
    }, MAP_WAIT_MS);
    // When a card or a panel changes size, such as when a Create button goes.
    const resized = new ResizeObserver(later);
    for (const watched of document.querySelectorAll(".needs .need, .stage > .card, .stage > .time")) resized.observe(watched);
    return () => {
      stop();
      resized.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [feed, list, needs]);
}

function useStill(media: MediaView): Still | null {
  const [still, setStill] = useState<Still | null>(null);
  useEffect(() => {
    if (media.kind !== "video") return;
    let live = true;
    void stillOf(media.url).then((value) => live && setStill(value));
    return () => {
      live = false;
    };
  }, [media.url, media.kind]);
  return still;
}

function Thumb({ need, media, onOpen }: { need: NeedView; media: MediaView; onOpen: (opened: Opened) => void }) {
  const still = useStill(media);
  const video = media.kind === "video";
  const open = (event: MouseEvent) => {
    const button = event.currentTarget as HTMLElement;
    const image = button.querySelector("img");
    const size: Size | null = video ? (still ? [still.width, still.height] : null) : image?.naturalWidth ? [image.naturalWidth, image.naturalHeight] : null;
    onOpen({ need, media, size, poster: still?.src, from: button });
  };
  return (
    <button type="button" class="thumb" aria-label={`${video ? "Play video" : "View image"}, ${need.title}, ${media.label.toLowerCase()}`} onClick={open}>
      {video ? still && <img src={still.src} alt="" /> : <img src={media.url} alt="" decoding="async" />}
      {video && (
        <span class="play" aria-hidden="true">
          <PlayIcon />
        </span>
      )}
    </button>
  );
}

type PinProps = {
  need: NeedView;
  status: NeedStatus;
  canCreate: boolean;
  onCreate: (need: NeedView) => Promise<boolean>;
  onOpen: (opened: Opened) => void;
  onDetails: (need: NeedView, status: NeedStatus, from: Element) => void;
};

function Pin({ need, status, canCreate, onCreate, onOpen, onDetails }: PinProps) {
  const card = useRef<HTMLButtonElement>(null);
  const [asking, setAsking] = useState(false);
  const refocus = useRef(false);
  const about = `need-${need.id}-about`;

  // The Create button goes once the need is being made. Focus moves to its card,
  // not to the top of the page.
  useLayoutEffect(() => {
    if (creatable(status) || !refocus.current) return;
    refocus.current = false;
    card.current?.focus();
  }, [status]);

  const create = async (event: MouseEvent) => {
    if (asking) return;
    refocus.current = document.activeElement === event.currentTarget;
    setAsking(true);
    const created = await onCreate(need);
    setAsking(false);
    if (!created) refocus.current = false;
  };

  return (
    <li class="pin" data-lat={need.lat} data-lon={need.lon}>
      <article class={`need ${status}`} aria-label={`${need.title}, ${need.place}`}>
        {/* Opens why it was proposed, and the pages it rests on. */}
        <button ref={card} type="button" class="words" aria-describedby={about} aria-haspopup="dialog" onClick={(event) => onDetails(need, status, event.currentTarget)}>
          <span class="title">{need.title}</span>
          <span class="state">{stateOf(need, status)}</span>
          <span class="place">{need.place}</span>
        </button>
        {/* After the words, so they never move as the need is made. */}
        {/* What is made so far, then one frame for what is still to come. */}
        <div class="slot">
          {latest(need).map((media) => (
            <Thumb key={media.id} need={need} media={media} onOpen={onOpen} />
          ))}
          {status === "ready" ? null : status === "creating" ? (
            <span class="working" aria-hidden="true">
              <span class="spinner" />
            </span>
          ) : status === "failed" ? (
            <span class="empty failed" aria-hidden="true">
              <AlertIcon />
            </span>
          ) : (
            <span class="empty" aria-hidden="true">
              {missing(need).map((kind) => (kind === "video" ? <VideoIcon key={kind} /> : <ImageIcon key={kind} />))}
            </span>
          )}
        </div>
        <p id={about} class="sr-only">
          Needs {article(need.kinds)}. {need.reason}
          {status === "failed" && need.failure ? ` It couldn't be made: ${need.failure}.` : ""}
        </p>
        {creatable(status) && canCreate && (
          <button type="button" class="create" aria-label={`${actionOf(status)}: ${need.title}, ${need.place}`} aria-disabled={asking} onClick={create}>
            {actionOf(status)}
          </button>
        )}
      </article>
      <span class="dot" aria-hidden="true" />
    </li>
  );
}

type ViewerProps = { opened: Opened | null; study: StudyView | null; onClose: () => void; onSources: (details: Details, from: Element) => void };

function Viewer({ opened, study, onClose, onSources }: ViewerProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!opened) {
      if (element.open) element.close();
      return;
    }
    if (!element.open) element.showModal();
    // Plays at once, unless motion is reduced, and always starts muted: nothing
    // checks what a generated sound track says. Its controls turn the sound on.
    const clip = video.current;
    if (clip) {
      clip.muted = true;
      if (!reduced()) void clip.play().catch(() => {});
    }
  }, [opened]);

  const close = () => dialog.current?.close();
  const closed = () => {
    const from = opened?.from;
    onClose();
    if (from?.isConnected) from.focus();
  };

  // Sized before the file arrives, so the sheet never jumps.
  const [width, height] = opened?.size ?? (opened?.media.kind === "video" ? [16, 9] : [1, 1]);
  const fit = { aspectRatio: `${width} / ${height}`, width: `min(732px, calc(94vw - 30px), calc(72vh * ${width / height}))` };

  return (
    <dialog ref={dialog} class="quicklook viewer" aria-labelledby="viewer-title" onClose={closed} onClick={(event) => event.target === dialog.current && close()}>
      {opened && (
        <div class="sheet">
          <header>
            <h2 id="viewer-title">
              {opened.need.title}
              <span class="place"> {opened.need.place}</span>
            </h2>
            <button type="button" class="close" aria-label="Close" onClick={close}>
              ×
            </button>
          </header>
          <figure class="media">
            {opened.media.kind === "video" ? (
              <video
                ref={video}
                src={opened.media.url}
                poster={opened.poster}
                controls
                muted
                playsInline
                preload="auto"
                style={fit}
                aria-label={`${opened.need.title}, ${opened.need.place}, video`}
                aria-describedby={opened.media.alt ? "viewer-alt" : undefined}
              />
            ) : (
              <img src={opened.media.url} alt={opened.media.alt ?? `${opened.need.title}, ${opened.need.place}`} style={fit} />
            )}
            <figcaption class="tag">{opened.media.label}</figcaption>
          </figure>
          {/* A video has no alt, so what it shows is said here, for everyone. */}
          {opened.media.kind === "video" && opened.media.alt && (
            <p id="viewer-alt" class="alt">
              {opened.media.alt}
            </p>
          )}
          <Made opened={opened} study={study} onSources={onSources} onClose={close} />
        </div>
      )}
    </dialog>
  );
}

// Which model made a file, and the pages it drew on, which open as any source does.
function Made({ opened, study, onSources, onClose }: { opened: Opened; study: StudyView | null; onSources: ViewerProps["onSources"]; onClose: () => void }) {
  const sources = sourcesOf(opened.media, study);
  const open = () => {
    onClose();
    onSources({ title: `${opened.need.title}, ${opened.need.place}`, sources, steps: [] }, opened.from);
  };
  return (
    <p class="made">
      Made with {MODELS[opened.media.model] ?? opened.media.model}
      {sources.length > 0 && (
        <>
          {" from "}
          <button type="button" class="link" aria-haspopup="dialog" onClick={open}>
            {pagesOf(sources)}
          </button>
        </>
      )}
    </p>
  );
}

type Props = { study: StudyView | null; feed: ViewFeed; canCreate: boolean; onDetails: (details: Details, from: Element) => void };

export function Needs({ study, feed, canCreate, onDetails }: Props) {
  const list = useRef<HTMLUListElement>(null);
  // Asked for here and accepted, before the log's echo arrives: each need as it was.
  const [asked, setAsked] = useState<ReadonlyMap<string, string>>(new Map());
  const [opened, setOpened] = useState<Opened | null>(null);
  const needs = study?.needs ?? [];
  useFollow(feed, list, needs);

  const create = async (need: NeedView) => {
    if (!study) return false;
    const response = await api(`/v1/studies/${study.id}/needs/${need.id}/create`, { method: "POST" }).catch(() => undefined);
    if (!response?.ok) return false;
    setAsked((before) => new Map(before).set(`${study.id}/${need.id}`, version(need)));
    return true;
  };

  const statusOf = (need: NeedView): NeedStatus => (asked.get(`${study?.id}/${need.id}`) === version(need) ? "creating" : need.status);

  // Why it was proposed and the pages it rests on, before a planner spends on it.
  const details = (need: NeedView, status: NeedStatus, from: Element) =>
    onDetails(
      {
        title: `${need.title}, ${need.place}`,
        sources: need.citations.map((citation) => ({ label: `p. ${citation.page}`, ...citation })),
        steps: [],
        note: need.reason,
        ...(status === "failed" && need.failure ? { alert: `It couldn't be made: ${need.failure}.` } : {}),
        ...(canCreate && creatable(status)
          ? { action: { label: actionOf(status), name: `${actionOf(status)}: ${need.title}, ${need.place}`, run: () => void create(need) } }
          : {}),
      },
      from,
    );

  return (
    <>
      {needs.length > 0 && (
        <ul ref={list} class="needs" aria-label="Engagement">
          {needs.map((need) => (
            <Pin key={need.id} need={need} status={statusOf(need)} canCreate={canCreate} onCreate={create} onOpen={setOpened} onDetails={details} />
          ))}
        </ul>
      )}
      <Viewer opened={opened} study={study} onClose={() => setOpened(null)} onSources={onDetails} />
    </>
  );
}
