// Takes a planner to what a notice is about, once its study shows: a finding, a
// need's card, the media viewer, where to decide, a decision or the agent's
// answer. Focus moves there, and the place glows for a moment, so it's seen as
// well as heard.
import type { Target } from "./notify.ts";

const FOCUSABLE = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]";
// How long to wait for the study to show, and for the map to place its needs.
const FRAMES = 90;
const GLOW_MS = 2000;

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const query = (selector: string) => document.querySelector<HTMLElement>(selector);
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// A need's card, as the engagement layer draws it.
const needCard = (id: string) =>
  query(`[data-need="${CSS.escape(id)}"]`) ?? document.getElementById(`need-${id}-about`)?.closest<HTMLElement>(".need") ?? null;

// An area's own focus, or its first control's.
const within = (area: HTMLElement, first = FOCUSABLE) =>
  area.matches(FOCUSABLE) ? area : (area.querySelector<HTMLElement>(first) ?? area.querySelector<HTMLElement>(FOCUSABLE) ?? area);

// A note past the card's first few is folded away: its fold opens, so it can take focus.
function unfold(element: HTMLElement | null): HTMLElement | null {
  const fold = element?.closest("details");
  if (fold && !fold.open) fold.open = true;
  return element;
}

type Found = { focus: HTMLElement; glow?: HTMLElement } | { press: HTMLElement };

// The element to focus and the area to light, or a button to press that opens
// what to focus.
function find(target: Target, studyId: string): Found | null {
  const card = query(`.card[data-study="${CSS.escape(studyId)}"]`);
  if (!card) return null;
  switch (target.kind) {
    case "finding": {
      const finding = unfold(card.querySelector<HTMLElement>(`[data-finding="${CSS.escape(target.id)}"]`));
      return finding && { focus: finding };
    }
    case "decide": {
      // A decision form where a planner can decide here. Without one, the hand-over
      // itself, which says what to decide, or else a finding awaiting a planner.
      const area = card.querySelector<HTMLElement>("#decide, .decide") ?? query("#decide, .decide");
      if (area) return { focus: within(area), glow: area };
      const handover = query(`.chat [data-seq="${target.seq}"]`) ?? unfold(card.querySelector<HTMLElement>(".finding.unrated"));
      return handover && { focus: handover };
    }
    case "decision": {
      // The card's line with the outcome, once the study's new values show it.
      const decision = card.querySelector<HTMLElement>(".decision");
      return decision && { focus: decision };
    }
    case "need": {
      const need = needCard(target.id);
      return need && { focus: within(need, `[aria-describedby="need-${CSS.escape(target.id)}-about"]`), glow: need };
    }
    case "media": {
      const need = needCard(target.need);
      const label = target.media === "video" ? "Play video" : "View image";
      const thumb = need?.querySelector<HTMLElement>(`.thumb[aria-label^="${label}"]`) ?? need?.querySelector<HTMLElement>(".thumb");
      return thumb ? { press: thumb } : need && { focus: within(need), glow: need };
    }
    case "message": {
      const message = query(`.chat [data-seq="${target.seq}"]`);
      return message && { focus: message };
    }
  }
}

function glow(element: HTMLElement) {
  element.classList.remove("noticed");
  void element.offsetWidth;
  element.classList.add("noticed");
  window.setTimeout(() => element.classList.remove("noticed"), GLOW_MS);
}

let pending = 0;

export async function reveal(target: Target, studyId: string): Promise<void> {
  const mine = ++pending;
  for (let i = 0; i < FRAMES; i++) {
    await frame();
    // A later Review takes over.
    if (mine !== pending) return;
    const found = find(target, studyId);
    if (!found) continue;
    if ("press" in found) {
      found.press.click();
      return;
    }
    const { focus, glow: area = focus } = found;
    if (!focus.matches(FOCUSABLE)) focus.setAttribute("tabindex", "-1");
    focus.focus({ preventScroll: true });
    // Hidden for now, as a need's card is while its place is off the map.
    if (document.activeElement !== focus) continue;
    area.scrollIntoView({ block: "center", behavior: reduced() ? "auto" : "smooth" });
    glow(area);
    return;
  }
  // It never showed, such as a need off the map: the study's card, at least.
  const card = query(`.card[data-study="${CSS.escape(studyId)}"]`);
  if (!card || mine !== pending) return;
  card.setAttribute("tabindex", "-1");
  card.focus({ preventScroll: true });
  glow(card);
}
