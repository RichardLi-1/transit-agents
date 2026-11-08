// The display's view of the service. It listens to the event stream and asks for
// fresh study values when something changes. It holds no truth of its own.
import { useEffect, useState } from "preact/hooks";
import type { Activity, Context, LogEntry, StudyView, Usage } from "@transit-agents/contracts";
import { api, bearer, eventsUrl } from "./api.ts";

export type Message = { seq: number; studyId: string | null; from: "agent" | "planner"; text: string };

export type Subagent = { id: string; studyId: string | null; question: string; summary?: string };

export type Store = {
  connected: boolean;
  contexts: Context[];
  studies: StudyView[];
  messages: Message[];
  subagents: Subagent[];
  reading: string | null;
  usage: Usage;
  replay: boolean;
  focus: string | null;
};

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, costUsd: 0, computeSeconds: 0, calls: 0 };

const initial: Store = {
  connected: false,
  contexts: [],
  studies: [],
  messages: [],
  subagents: [],
  reading: null,
  usage: EMPTY_USAGE,
  replay: false,
  focus: null,
};

// How long a folder stays lit after the agent reads from it.
const READING_MS = 1600;

function reduce(store: Store, entry: LogEntry): Store {
  if (entry.type === "context.added") {
    const context = { ...(entry.data as Context), addedAt: entry.at, addedBy: entry.actor };
    return { ...store, contexts: [...store.contexts.filter((c) => c.id !== context.id), context] };
  }
  if (entry.type !== "activity") return entry.studyId ? { ...store, focus: entry.studyId } : store;

  const activity = entry.data as Activity;
  const next = { ...store, focus: entry.studyId ?? store.focus, replay: entry.actor === "agent:replay" };
  switch (activity.kind) {
    case "message":
      return {
        ...next,
        messages: [
          ...store.messages,
          { seq: entry.seq, studyId: entry.studyId, from: entry.actor.startsWith("planner") ? "planner" : "agent", text: activity.text },
        ],
      };
    case "reading":
      return { ...next, reading: activity.contextId };
    case "subagent.started":
      return {
        ...next,
        subagents: [
          ...store.subagents.filter((s) => !(s.id === activity.id && s.studyId === entry.studyId)),
          { id: activity.id, studyId: entry.studyId, question: activity.question },
        ],
      };
    case "subagent.finished":
      return {
        ...next,
        subagents: store.subagents.map((s) => (s.id === activity.id && s.studyId === entry.studyId ? { ...s, summary: activity.summary } : s)),
      };
    case "run.started":
      return { ...next, subagents: store.subagents.filter((s) => s.studyId !== entry.studyId) };
    case "usage":
      return {
        ...next,
        usage: {
          inputTokens: store.usage.inputTokens + activity.inputTokens,
          outputTokens: store.usage.outputTokens + activity.outputTokens,
          costUsd: store.usage.costUsd + (activity.costUsd ?? 0),
          computeSeconds: store.usage.computeSeconds + (activity.computeSeconds ?? 0),
          calls: store.usage.calls + 1,
        },
      };
    default:
      return next;
  }
}

const REFRESHES = /^(study|figure|check|finding|assumption|decision)\./;

const EVENT_TYPES = [
  "context.added",
  "study.opened",
  "figure.recorded",
  "figure.rejected",
  "check.recorded",
  "finding.recorded",
  "assumption.set",
  "decision.recorded",
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
    let stopped = false;
    let source: EventSource | undefined;
    const loadStudies = () => {
      clearTimeout(refresh);
      refresh = window.setTimeout(async () => {
        const response = await api("/v1/studies");
        if (!response.ok) return;
        const studies = (await response.json()) as StudyView[];
        setStore((s) => ({ ...s, studies }));
      }, 120);
    };

    const onEntry = (event: MessageEvent<string>) => {
      const entry = JSON.parse(event.data) as LogEntry;
      last = entry.seq;
      setStore((s) => reduce(s, entry));
      if (REFRESHES.test(entry.type)) loadStudies();
      if (entry.type === "activity" && (entry.data as Activity).kind === "reading") {
        clearTimeout(idle);
        idle = window.setTimeout(() => setStore((s) => ({ ...s, reading: null })), READING_MS);
      }
    };

    const connect = async () => {
      const token = await bearer();
      if (stopped) return;
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
