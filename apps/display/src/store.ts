// The display's view of the service. It listens to the event stream and asks for
// fresh study values when something changes. It holds no truth of its own.
import { useEffect, useState } from "preact/hooks";
import type { Activity, Assumption, Context, LogEntry, StudyView, Usage } from "@transit-agents/contracts";
import { api, bearer, eventsUrl } from "./api.ts";

// replay is true for the scripted replay's work, which no model did. It's kept for
// each message and sub-agent, so a study's chat says so whatever comes after.
export type Message = { seq: number; studyId: string | null; from: "agent" | "planner"; text: string; replay: boolean };

// seq is the log entry that started it, so the chat can show it among the messages.
// ok is false for one that stopped before answering.
export type Subagent = { seq: number; id: string; studyId: string | null; question: string; summary?: string; ok?: boolean; replay: boolean };

export const REPLAY = "agent:replay";

export type Store = {
  connected: boolean;
  contexts: Context[];
  studies: StudyView[];
  // The rules and values planners set, so a figure can say whether it has a page.
  assumptions: Assumption[];
  // The log's last entry when the display connected: anything after it is new.
  since: number | null;
  messages: Message[];
  subagents: Subagent[];
  reading: string | null;
  // Each study's, since the chat shows the open study's spend. Calls reported
  // without a cost are counted, so no dollar sum shows while one is missing.
  usage: Record<string, Usage>;
  focus: string | null;
};

export const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, computeSeconds: 0, calls: 0 };

export const initial: Store = {
  connected: false,
  contexts: [],
  studies: [],
  assumptions: [],
  since: null,
  messages: [],
  subagents: [],
  reading: null,
  usage: {},
  focus: null,
};

// How long a folder stays lit after the agent reads from it.
const READING_MS = 1600;

// Only new work moves the focus: a study opening, or activity on one. What the log
// already held when the display opened fills the view, but leaves the camera where
// it is, and so does a planner's rating or decision.
export function reduce(store: Store, entry: LogEntry, live = true): Store {
  if (entry.type === "context.added") {
    const context = { ...(entry.data as Context), addedAt: entry.at, addedBy: entry.actor };
    return { ...store, contexts: [...store.contexts.filter((c) => c.id !== context.id), context] };
  }
  const moves = entry.type === "study.opened" || entry.type === "activity";
  const focus = live && moves && entry.studyId ? entry.studyId : store.focus;
  if (entry.type !== "activity") return focus === store.focus ? store : { ...store, focus };

  const activity = entry.data as Activity;
  const next = { ...store, focus };
  const replay = entry.actor === REPLAY;
  switch (activity.kind) {
    case "message":
      return {
        ...next,
        messages: [
          ...store.messages,
          { seq: entry.seq, studyId: entry.studyId, from: entry.actor.startsWith("planner") ? "planner" : "agent", text: activity.text, replay },
        ],
      };
    case "reading":
      return { ...next, reading: activity.contextId };
    case "subagent.started":
      return {
        ...next,
        subagents: [
          ...store.subagents.filter((s) => !(s.id === activity.id && s.studyId === entry.studyId)),
          { seq: entry.seq, id: activity.id, studyId: entry.studyId, question: activity.question, replay },
        ],
      };
    case "subagent.finished":
      return {
        ...next,
        subagents: store.subagents.map((s) =>
          s.id === activity.id && s.studyId === entry.studyId ? { ...s, summary: activity.summary, ok: activity.ok !== false } : s,
        ),
      };
    case "run.started":
      return { ...next, subagents: store.subagents.filter((s) => s.studyId !== entry.studyId) };
    case "usage": {
      if (!entry.studyId) return next;
      const usage = store.usage[entry.studyId] ?? EMPTY_USAGE;
      return {
        ...next,
        usage: {
          ...store.usage,
          [entry.studyId]: {
            inputTokens: usage.inputTokens + activity.inputTokens,
            outputTokens: usage.outputTokens + activity.outputTokens,
            costUsd: usage.costUsd + (activity.costUsd ?? 0),
            computeSeconds: usage.computeSeconds + (activity.computeSeconds ?? 0),
            calls: usage.calls + 1,
            unpricedCalls: (usage.unpricedCalls ?? 0) + (activity.costUsd === undefined ? 1 : 0),
          },
        },
      };
    }
    default:
      return next;
  }
}

const REFRESHES = /^(study|figure|check|finding|assumption|decision|need|media)\./;

const EVENT_TYPES = [
  "context.added",
  "study.opened",
  "figure.recorded",
  "figure.rejected",
  "check.recorded",
  "finding.recorded",
  "assumption.set",
  "decision.recorded",
  "need.added",
  "need.create.requested",
  "need.create.failed",
  "media.added",
  "activity",
];

// Connects once the display knows who it is, and so which token to send.
export function useStore(ready: boolean): Store {
  const [store, setStore] = useState(initial);

  useEffect(() => {
    if (!ready) return;
    let refresh = 0;
    let idle = 0;
    let last = 0;
    // The log's last entry when the display connected. Anything after it is new.
    let opened: number | undefined;
    let stopped = false;
    let source: EventSource | undefined;
    const loadStudies = () => {
      clearTimeout(refresh);
      refresh = window.setTimeout(async () => {
        const [response, rules] = await Promise.all([api("/v1/studies"), api("/v1/assumptions").catch(() => undefined)]);
        if (!response.ok) return;
        const studies = (await response.json()) as StudyView[];
        const assumptions = rules?.ok ? ((await rules.json()) as Assumption[]) : undefined;
        setStore((s) => ({ ...s, studies, assumptions: assumptions ?? s.assumptions }));
      }, 120);
    };

    const onEntry = (event: MessageEvent<string>) => {
      const entry = JSON.parse(event.data) as LogEntry;
      last = entry.seq;
      setStore((s) => reduce(s, entry, entry.seq > (opened ?? Infinity)));
      if (REFRESHES.test(entry.type)) loadStudies();
      if (entry.type === "activity" && (entry.data as Activity).kind === "reading") {
        clearTimeout(idle);
        idle = window.setTimeout(() => setStore((s) => ({ ...s, reading: null })), READING_MS);
      }
    };

    const connect = async () => {
      const token = await bearer();
      opened ??= await api("/v1/log/head")
        .then(async (r) => (r.ok ? ((await r.json()) as { seq: number }).seq : 0))
        .catch(() => 0);
      if (stopped) return;
      const since = opened;
      setStore((s) => (s.since === since ? s : { ...s, since }));
      const stream = new EventSource(eventsUrl(token, last));
      source = stream;
      stream.onopen = () => setStore((s) => ({ ...s, connected: true }));
      stream.onerror = () => {
        setStore((s) => ({ ...s, connected: false }));
        // The browser reconnects by itself, unless the service refused the token.
        // A signed-in person's token expires, so try again only with a new one.
        if (stream.readyState !== EventSource.CLOSED) return;
        void bearer().then((next) => {
          if (next !== token && !stopped) void connect();
        });
      };
      for (const type of EVENT_TYPES) stream.addEventListener(type, onEntry as EventListener);
    };
    void connect();

    return () => {
      stopped = true;
      source?.close();
      clearTimeout(refresh);
      clearTimeout(idle);
    };
  }, [ready]);

  return store;
}
