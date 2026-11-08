import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { spentUsd } from "../money.ts";
import { withCites } from "../cites.ts";
import { refusal, setNotice, unsaid, useNotice } from "../notice.ts";
import { plain } from "../plain.ts";
import { EMPTY_USAGE, type Store } from "../store.ts";
import { typing } from "../typing.ts";
import { CheckIcon, SendIcon, StaleIcon } from "./icons.tsx";

const number = new Intl.NumberFormat("en-CA");

// Offered until the viewer says something, so a first look isn't a wall of text.
const SUGGESTIONS = [
  "What would it cost to extend the Ontario Line up Don Mills to Sheppard?",
  "How often does the 25 Don Mills bus run at peak?",
  "Compare the two alignment options",
  "What changes if it ends at Lawrence?",
  "What's a QCRA, and does this estimate have one?",
  "Who needs to hear about this?",
];
const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

type Props = {
  store: Store;
  studyId: string | null;
  canPost: boolean;
  // Opens a cited page, as a figure's source opens.
  onPage: (contextId: string, page: number, element: Element) => void;
};

// A message's text, with each cited page a button that opens it.
function Text({ text, ids, onPage }: { text: string; ids: string[]; onPage: Props["onPage"] }) {
  return (
    <>
      {withCites(plain(text), ids).map((piece, i) =>
        typeof piece === "string" ? (
          piece
        ) : (
          <button key={i} type="button" class="cite" onClick={(event) => onPage(piece.contextId, piece.page, event.currentTarget)}>
            {piece.text}
          </button>
        ),
      )}
    </>
  );
}

// How fast a new answer types out, in characters a second.
const STREAM_CPS = 320;
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// A new agent answer, typed out as it arrives. Screen readers get the whole text once;
// the typing is for the eye only. `onGrow` keeps the log's foot in view as it grows.
function Streamed({ text, ids, onPage, onGrow }: { text: string; ids: string[]; onPage: Props["onPage"]; onGrow: () => void }) {
  const full = plain(text);
  const [shown, setShown] = useState(() => (still() ? full.length : 0));
  useEffect(() => {
    if (shown >= full.length) return;
    const started = performance.now() - (shown / STREAM_CPS) * 1000;
    let frame = 0;
    const tick = (now: number) => {
      const next = Math.min(full.length, Math.ceil(((now - started) / 1000) * STREAM_CPS));
      setShown(next);
      onGrow();
      if (next < full.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [full]);
  if (shown >= full.length) return <Text text={text} ids={ids} onPage={onPage} />;
  // Cut at a word, so a page cite isn't half a button; it becomes one when it's whole.
  const cut = full.lastIndexOf(" ", shown);
  return (
    <>
      <span class="sr-only">{full}</span>
      <span aria-hidden="true">
        {full.slice(0, cut > 0 ? cut : shown)}
        <span class="caret" />
      </span>
    </>
  );
}

export function Chat({ store, studyId, canPost, onPage }: Props) {
  const ids = store.contexts.map((context) => context.id);
  const [text, setText] = useState("");
  // Whether the earlier messages show, and whether the viewer has said anything yet.
  const [expanded, setExpanded] = useState(false);
  const [sent, setSent] = useState(false);
  useEffect(() => setExpanded(false), [studyId]);
  const log = useRef<HTMLDivElement>(null);
  // Answers already in the log when the chat first drew show whole; later ones type out.
  const firstSeen = useRef<number | null>(null);
  const messages = store.messages.filter((m) => m.studyId === studyId);
  const subagents = store.subagents.filter((s) => s.studyId === studyId);
  // Messages and sub-agents in the order the log has them.
  const items = [...messages, ...subagents].sort((a, b) => a.seq - b.seq);
  // Whether any of this study's chat is the scripted replay's, whatever came after.
  const replay = items.some((item) => item.replay);
  // The open study's spend, not every study's.
  const usage = (studyId && store.usage[studyId]) || EMPTY_USAGE;
  const spent = spentUsd(usage);
  const notice = useNotice();
  // The agent is at work: a run has started, and nothing has answered it yet.
  const working = typing(studyId ? store.openRuns[studyId] : undefined, items);
  // What the log held when the page opened folds away behind one line.
  const since = store.since ?? Infinity;
  const earlier = items.filter((item) => item.seq <= since).length;
  const shown = expanded ? items : items.filter((item) => item.seq > since);
  if (firstSeen.current === null) firstSeen.current = Math.max(since === Infinity ? 0 : since, ...items.map((item) => item.seq), 0);
  const toFoot = () => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  // The notice takes room from the foot of the log, so the last message is kept in view.
  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, subagents, notice, working]);

  const send = (event: Event) => {
    event.preventDefault();
    void post(text, true);
  };

  // `typed`: the words came from the box, so they go back in it if not sent.
  const post = async (words: string, typed: boolean) => {
    const trimmed = words.trim();
    if (!trimmed || !studyId) return;
    setSent(true);
    if (typed) setText("");
    const response = await api(`/v1/studies/${studyId}/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "message", text: trimmed }),
    }).catch(() => undefined);
    if (response?.ok) return setNotice(null);
    // Not sent: the words come back, unless more has been typed since, and the service says
    // why, unless the chat has just said it.
    if (typed) setText((now) => now || words);
    setNotice(unsaid(await refusal(response), messages.at(-1)?.text));
  };

  return (
    <aside class="chat" aria-label="Agent">
      {replay && <p class="tag">Replay</p>}
      <div class="log" ref={log} role="log" aria-live="polite" tabIndex={0} aria-label="Agent activity">
        {earlier > 0 && (
          <button type="button" class="earlier" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide earlier messages" : `Earlier: ${number.format(earlier)} ${earlier === 1 ? "message" : "messages"}`}
          </button>
        )}
        {shown.map((item) =>
          "text" in item ? (
            <p key={`m${item.seq}`} class={`bubble ${item.from}`} data-seq={item.seq}>
              {item.replay && <span class="sr-only">Replay: </span>}
              {item.from === "agent" && !item.replay && item.seq > (firstSeen.current ?? Infinity) ? (
                <Streamed text={item.text} ids={ids} onPage={onPage} onGrow={toFoot} />
              ) : (
                <Text text={item.text} ids={ids} onPage={onPage} />
              )}
            </p>
          ) : (
            <div key={`s${item.id}`} class={`sub${item.summary ? (item.ok ? " done" : " stopped") : ""}`}>
              <span class="mark" aria-hidden="true">
                {item.summary && (item.ok ? <CheckIcon /> : <StaleIcon />)}
              </span>
              <div>
                <p class="question">{item.question}</p>
                {item.summary && (
                  <p>
                    <Text text={item.summary} ids={ids} onPage={onPage} />
                  </p>
                )}
              </div>
            </div>
          ),
        )}
        {/* Added once as a run starts, so the log says it once; the dots move, the words don't. */}
        {working && (
          <p class="bubble agent typing">
            <span class="dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            Working…
          </p>
        )}
      </div>
      {canPost && !sent && studyId && (
        <div class="suggestions">
          <p id="suggestions-title">Some things I can do</p>
          <ul aria-labelledby="suggestions-title">
            {SUGGESTIONS.map((suggestion) => (
              <li key={suggestion}>
                <button type="button" onClick={() => void post(suggestion, false)}>
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Between the log and the form, so its arrival moves nothing but the log's foot. */}
      <p class="refusal" role="status">
        {notice}
      </p>
      {usage.calls > 0 && (
        <p class="usage">
          {/* One text node: as the count grows, nothing after it moves. */}
          {`${number.format(usage.inputTokens + usage.outputTokens)} tokens${spent !== null ? ` · ${money.format(spent)}` : ""}`}
        </p>
      )}
      {canPost && (
        <form onSubmit={send}>
          <input
            type="text"
            value={text}
            aria-label="Message"
            placeholder="Message"
            autocomplete="off"
            onInput={(event) => setText(event.currentTarget.value)}
          />
          <button type="submit" aria-label="Send" disabled={!text.trim() || !studyId}>
            <SendIcon />
          </button>
        </form>
      )}
    </aside>
  );
}
