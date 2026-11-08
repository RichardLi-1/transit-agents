// What a planner hears about: a case an agent hands them, a need an agent proposes,
// media that is ready, a decision, an answer, and a brief a planner changed. Only new entries notify. What the
// log already held when the display opened only fills in what a notice names, such
// as the place a need is for.
import { HANDOVER, NO_ANSWER, type Activity, type LogEntry, type Outcome } from "@transit-agents/contracts";

export type NoticeKind = "finding" | "handover" | "need" | "media" | "decision" | "answer" | "brief";

// Where Review takes the planner. A hand-over goes to where a planner decides,
// and its message says what to decide. A decision goes to the card's decision.
export type Target =
  | { kind: "finding"; id: string }
  | { kind: "decide"; seq: number }
  | { kind: "decision" }
  | { kind: "need"; id: string }
  | { kind: "media"; need: string; media: "image" | "video" }
  | { kind: "message"; seq: number }
  // The card's figures a changed input moved, the first that shows taking focus.
  | { kind: "figures"; ids: string[] };

export type Notice = {
  // The entry that raised it, and the latest one folded into it.
  id: number;
  seq: number;
  at: string;
  studyId: string;
  kind: NoticeKind;
  text: string;
  // Findings an agent records together make one notice.
  count: number;
  target: Target;
};

export type Heard = {
  // Oldest first.
  notices: Notice[];
  // Each study's last agent message, until anything but reading follows it.
  said: Record<string, { seq: number; text: string } | undefined>;
  // Each need's place, by study and need, so the media made for it can say where.
  places: Record<string, string>;
};

export const NOTHING_HEARD: Heard = { notices: [], said: {}, places: {} };

// How many the list keeps, and how close together findings must come to make one.
export const KEEP = 30;
const TOGETHER_MS = 15_000;

const OUTCOME: Record<Outcome, string> = { adopt: "Adopted", reject: "Not adopted", defer: "Deferred", amend: "Amended" };

const CALL = "Needs your call";

// A person's own words and work, a planner's or a visitor's: never an agent's, so never a notice.
const PERSON = /^(planner|guest):/;

type Raised = Pick<Notice, "kind" | "text" | "target">;

const field = (data: unknown, key: string) => {
  const value = (data as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : undefined;
};

// What one entry adds to what the display has heard. `live` is false for entries
// the log held when the display opened: they never notify.
export function hear(heard: Heard, entry: LogEntry, live: boolean): Heard {
  if (entry.type === "assumption.set") return live ? briefChanged(heard, entry) : heard;
  const studyId = entry.studyId;
  if (!studyId) return heard;
  const person = PERSON.test(entry.actor);
  let { said, places } = heard;
  let raised: Raised | null = null;

  if (entry.type === "activity") {
    const activity = entry.data as Activity;
    if (activity.kind === "message") {
      said = { ...said, [studyId]: person ? undefined : { seq: entry.seq, text: activity.text } };
    } else if (activity.kind === "run.finished") {
      const last = said[studyId];
      if (last && HANDOVER.test(last.text)) raised = { kind: "handover", text: CALL, target: { kind: "decide", seq: last.seq } };
      else if (last && !NO_ANSWER.test(last.text)) raised = { kind: "answer", text: "Answer ready", target: { kind: "message", seq: last.seq } };
    }
  }
  // A run's answer is its last word: anything it does after a message, but read,
  // means the message wasn't the end.
  const reads = entry.type === "activity" && ["message", "reading", "usage"].includes((entry.data as Activity).kind);
  if (!reads && said[studyId]) said = { ...said, [studyId]: undefined };

  switch (entry.type) {
    case "finding.recorded": {
      // An agent's tone is only a proposal, so its finding waits for a planner's rating.
      const id = field(entry.data, "id");
      if (!person && id) raised = { kind: "finding", text: CALL, target: { kind: "finding", id } };
      break;
    }
    case "need.added": {
      const id = field(entry.data, "id");
      const place = field(entry.data, "place");
      if (!id) break;
      if (place) places = { ...places, [`${studyId}/${id}`]: place };
      const title = field(entry.data, "title");
      if (!person) raised = { kind: "need", text: `Proposed: ${[title, place].filter(Boolean).join(", ") || "engagement need"}`, target: { kind: "need", id } };
      break;
    }
    case "media.added": {
      const need = field(entry.data, "need");
      const kind = field(entry.data, "kind") === "video" ? "video" : "image";
      if (!need) break;
      const place = places[`${studyId}/${need}`];
      raised = { kind: "media", text: `Illustrative ${kind} ready${place ? `: ${place}` : ""}`, target: { kind: "media", need, media: kind } };
      break;
    }
    case "decision.recorded": {
      const outcome = field(entry.data, "outcome");
      const by = field(entry.data, "decidedBy");
      const what = OUTCOME[outcome as Outcome] ?? outcome ?? "recorded";
      raised = { kind: "decision", text: `Decided: ${what}${by ? `, by ${by}` : ""}`, target: { kind: "decision" } };
      break;
    }
  }

  const notices = live && raised ? add(heard.notices, raised, entry, studyId) : heard.notices;
  if (notices === heard.notices && said === heard.said && places === heard.places) return heard;
  return { notices, said, places };
}

const amount = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 4 });

// A planner set a rule or assumption: each study whose figures or checks it moved
// hears that its brief changed, with the input and its new value. An assumption
// belongs to no one study, so its effects say which.
function briefChanged(heard: Heard, entry: LogEntry): Heard {
  const data = entry.data as { key?: string; label?: string; value?: number; unit?: string; effects?: { studyId: string; figures?: { id: string }[] }[] } | null;
  if (typeof data?.value !== "number") return heard;
  const unit = data.unit ? ` ${data.unit}` : "";
  const text = `Brief changed: ${data.label || data.key || "an input"}, now ${amount.format(data.value)}${unit}`;
  let notices = heard.notices;
  (data.effects ?? []).forEach((effect, i) => {
    const target: Target = { kind: "figures", ids: (effect.figures ?? []).map((figure) => figure.id) };
    // One entry, a notice for each study: each needs an id of its own.
    notices = [...notices, { kind: "brief" as const, text, target, id: entry.seq + i / 1000, seq: entry.seq, at: entry.at, studyId: effect.studyId, count: 1 }].slice(-KEEP);
  });
  return notices === heard.notices ? heard : { ...heard, notices };
}

// Findings an agent records on one study in a burst fold into one notice.
function add(notices: Notice[], raised: Raised, entry: LogEntry, studyId: string): Notice[] {
  const last = notices.at(-1);
  if (raised.kind === "finding" && last?.kind === "finding" && last.studyId === studyId && Date.parse(entry.at) - Date.parse(last.at) <= TOGETHER_MS) {
    return [...notices.slice(0, -1), { ...last, seq: entry.seq, at: entry.at, count: last.count + 1 }];
  }
  return [...notices, { ...raised, id: entry.seq, seq: entry.seq, at: entry.at, studyId, count: 1 }].slice(-KEEP);
}

// The whole notice in words, for a screen reader or a browser notification.
export function spoken(notice: Notice, study: string): string {
  return [notice.text, notice.count > 1 ? `${notice.count} notes` : "", study].filter(Boolean).join(", ");
}

// Notices that come together, said in one go, so none replaces another unread.
export function spokenTogether(notices: Notice[], study: (id: string) => string): string {
  return notices.map((notice) => spoken(notice, study(notice.studyId))).join(". ");
}
