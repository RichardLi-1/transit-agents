import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { EXECUTIVE } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { spentUsd } from "../money.ts";
import { withCites } from "../cites.ts";
import { echoesDocument } from "../echo.ts";
import { refusal, setNotice, unsaid, useNotice } from "../notice.ts";
import { plain, plainBold } from "../plain.ts";
import { EMPTY_USAGE, type Store } from "../store.ts";
import { local, unasked, wantsSimulator, withAsked, type Asked } from "../suggestions.ts";
import { foldAt, waiting } from "../typing.ts";
import { DocumentCard } from "./DocumentCard.tsx";
import { ExecutiveCard, withoutExecutive, type Ping } from "./ExecutiveCard.tsx";
import { CheckIcon, SendIcon, StaleIcon } from "./icons.tsx";

const number = new Intl.NumberFormat("en-CA");

// The suggestions asked in each study, kept for the tab, so a reload doesn't offer
// them again.
const ASKED_KEY = "chat.asked";
function readAsked(): Asked {
  try {
    const kept = JSON.parse(sessionStorage.getItem(ASKED_KEY) ?? "{}") as unknown;
    return kept && typeof kept === "object" && !Array.isArray(kept) ? (kept as Asked) : {};
  } catch {
    return {};
  }
}
function keepAsked(asked: Asked): Asked {
  try {
    sessionStorage.setItem(ASKED_KEY, JSON.stringify(asked));
  } catch {
    // Kept for the page only.
  }
  return asked;
}

// With the agent at work and nothing new from it for this long, it's taken to
// have stopped, and the chat says so rather than showing the dots for ever.
const STALL_MS = 60_000;
// Within this of the foot, the log follows new messages; further up, it stays put.
const FOOT_PX = 48;
const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

type Props = {
  store: Store;
  studyId: string | null;
  canPost: boolean;
  // Who a planner can ping about an answer's executive decision.
  ping: Ping;
  // Opens a cited page, as a figure's source opens.
  onPage: (contextId: string, page: number, element: Element) => void;
};

// A piece of an answer with its **bold** parts drawn bold.
const bolded = (piece: string, at: number) =>
  piece.split(/\*\*(?=\S)([^*]*?\S)\*\*/g).map((part, i) => (i % 2 ? <strong key={`${at}-${i}`}>{part}</strong> : part));

// A message's text, with each cited page a button that opens it.
function Text({ text, ids, onPage }: { text: string; ids: string[]; onPage: Props["onPage"] }) {
  return (
    <>
      {withCites(plainBold(text), ids).map((piece, i) =>
        typeof piece === "string" ? (
          bolded(piece, i)
        ) : (
          <button key={i} type="button" class="cite" onClick={(event) => onPage(piece.contextId, piece.page, event.currentTarget)}>
            {piece.text}
          </button>
        ),
      )}
    </>
  );
}

// An agent's answer that ends asking for an executive's decision.
const executive = (message: { from: string; text: string }) => message.from === "agent" && EXECUTIVE.test(message.text);

// How fast a new answer types out, in characters a second.
const STREAM_CPS = 320;
const still = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// A new agent answer, typed out as it arrives. Screen readers get the whole text once;
// the typing is for the eye only.
// `onDone` says it has shown whole, or gone, so it never types out again.
function Streamed({ text, ids, onPage, onDone }: { text: string; ids: string[]; onPage: Props["onPage"]; onDone: () => void }) {
  const full = plain(text);
  const [shown, setShown] = useState(() => (still() ? full.length : 0));
  useEffect(() => () => onDone(), []);
  useEffect(() => {
    if (shown >= full.length) {
      onDone();
      return;
    }
    const started = performance.now() - (shown / STREAM_CPS) * 1000;
    let frame = 0;
    const tick = (now: number) => {
      const next = Math.min(full.length, Math.ceil(((now - started) / 1000) * STREAM_CPS));
      setShown(next);
      if (next < full.length) frame = requestAnimationFrame(tick);
      else onDone();
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

export function Chat({ store, studyId, canPost, ping, onPage }: Props) {
  const ids = store.contexts.map((context) => context.id);
  const [text, setText] = useState("");
  // Whether the earlier messages show, and the studies the viewer has said something in.
  const [expanded, setExpanded] = useState(false);
  const [asked, setAsked] = useState<Asked>(readAsked);
  const [sending, setSending] = useState(false);
  const log = useRef<HTMLDivElement>(null);
  // Whether the log is at its foot, so it follows what comes next.
  const atFoot = useRef(true);
  useEffect(() => {
    setExpanded(false);
    atFoot.current = true;
  }, [studyId]);
  // Each agent answer, as the chat first sees it: whether it types out. Only one that
  // arrives while its study shows, after the log has loaded, does, and only once:
  // never what the log held, nor what shows on expanding Earlier or opening a study.
  const streams = useRef(new Map<number, boolean>());
  for (const m of store.messages) {
    if (!streams.current.has(m.seq)) {
      streams.current.set(m.seq, m.from === "agent" && !m.replay && store.since !== null && m.seq > store.since && m.studyId === studyId);
    }
  }
  const messages = store.messages.filter((m) => m.studyId === studyId);
  const subagents = store.subagents.filter((s) => s.studyId === studyId);
  const documents = store.documents.filter((d) => d.studyId === studyId);
  const escalations = store.escalations.filter((e) => e.studyId === studyId);
  // An answer that types out shows its executive card once it's whole.
  const [, typed] = useState(0);
  // Messages, sub-agents and documents in the order the log has them.
  const items = [...messages, ...subagents, ...documents].sort((a, b) => a.seq - b.seq);
  // Whether any of this study's chat is the scripted replay's, whatever came after.
  const replay = items.some((item) => item.replay);
  // The open study's spend, not every study's.
  const usage = (studyId && store.usage[studyId]) || EMPTY_USAGE;
  const spent = spentUsd(usage);
  const notice = useNotice();
  const run = studyId ? store.openRuns[studyId] : undefined;
  // The agent is at work: a run has started and not answered, or a question is waiting for one.
  const working = waiting(run, items, store.since);
  // Anything the agent does: a word, a sub-agent's step, a run starting or ending,
  // a model call or a page read. Each puts off saying it has stopped.
  const pulse = [studyId, items.length, subagents.filter((s) => s.summary !== undefined).length, run, usage.calls, store.reading].join("|");
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    setStalled(false);
    if (!working) return;
    const timer = window.setTimeout(() => setStalled(true), STALL_MS);
    return () => window.clearTimeout(timer);
  }, [pulse, working]);
  // What the log held when the page opened folds away behind one line, except a
  // question still being answered.
  const since = foldAt(store.since, run, items);
  const earlier = items.filter((item) => item.seq <= since).length;
  const urls = documents.map((d) => d.url);
  // The lead's "Document ready" line repeats its document's card, so only the card shows.
  const shown = (expanded ? items : items.filter((item) => item.seq > since)).filter(
    (item) => !("text" in item && item.from === "agent" && echoesDocument(item.text, urls)),
  );
  const question = messages.filter((m) => m.from === "planner").at(-1)?.text;
  const left = studyId ? unasked(asked, studyId) : [];

  const toFoot = () => {
    const element = log.current;
    if (element && atFoot.current) element.scrollTop = element.scrollHeight;
  };
  const onScroll = () => {
    const element = log.current;
    if (element) atFoot.current = element.scrollHeight - element.scrollTop - element.clientHeight < FOOT_PX;
  };
  // Whatever changes in the log, such as a message, an answer typing out or
  // showing whole, or the dots, keeps the last message in view, unless the viewer
  // has scrolled up to read. So do the notice and the suggestions, which take room
  // from its foot: the suggestions come back as a run finishes.
  useLayoutEffect(toFoot, [studyId, notice, working, left.length]);
  useEffect(() => {
    const element = log.current;
    if (!element) return;
    const observer = new MutationObserver(toFoot);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, []);

  const send = (event: Event) => {
    event.preventDefault();
    void post(text, true);
  };

  // `typed`: the words came from the box, which empties as they go. Not sent, they
  // come back to it, unless more has been typed since, with the service's reason.
  const post = async (words: string, typed: boolean) => {
    const trimmed = words.trim();
    if (!trimmed || !studyId || sending) return;
    if (!local && wantsSimulator(trimmed)) {
      // Opened before any wait, so the browser counts it as the viewer's own click.
      window.open("/simulator/#thinking", "simulator", "popup,width=1440,height=860");
      if (typed) setText("");
      setAsked((now) => keepAsked(withAsked(now, studyId, trimmed)));
      setNotice("The simulator: thinking…");
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return setNotice("The simulator opened in a new window, for you to try. On a planner's own computer, Gemini drives it by sight.");
    }
    setSending(true);
    if (typed) setText("");
    atFoot.current = true;
    const response = await api(`/v1/studies/${studyId}/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "message", text: trimmed }),
    }).catch(() => undefined);
    setSending(false);
    if (response?.ok) {
      setAsked((now) => keepAsked(withAsked(now, studyId, trimmed)));
      return setNotice(null);
    }
    setText((now) => now || trimmed);
    const reason = response ? ((await refusal(response)) ?? "Not sent. Try again.") : "Not sent: the service can't be reached. Try again.";
    setNotice(unsaid(reason, messages.at(-1)?.text));
  };

  return (
    <aside class="chat" aria-label="Agent">
      {replay && <p class="tag">Replay</p>}
      <div class="log" ref={log} role="log" aria-live="polite" tabIndex={0} aria-label="Agent activity" onScroll={onScroll}>
        {earlier > 0 && (
          <button type="button" class="earlier" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide earlier messages" : `Earlier: ${number.format(earlier)} ${earlier === 1 ? "message" : "messages"}`}
          </button>
        )}
        {shown.map((item) =>
          "url" in item ? (
            <DocumentCard key={`d${item.seq}`} document={item} />
          ) : "text" in item ? (
            <Fragment key={`m${item.seq}`}>
              <p class={`bubble ${item.from}`} data-seq={item.seq}>
                {item.replay && <span class="sr-only">Replay: </span>}
                {streams.current.get(item.seq) ? (
                  <Streamed
                    text={executive(item) ? withoutExecutive(item.text) : item.text}
                    ids={ids}
                    onPage={onPage}
                    onDone={() => {
                      if (streams.current.get(item.seq)) typed((n) => n + 1);
                      streams.current.set(item.seq, false);
                    }}
                  />
                ) : (
                  <Text text={executive(item) ? withoutExecutive(item.text) : item.text} ids={ids} onPage={onPage} />
                )}
              </p>
              {executive(item) && studyId && !streams.current.get(item.seq) && (
                <ExecutiveCard
                  studyId={studyId}
                  seq={item.seq}
                  text={item.text}
                  sent={escalations.filter((e) => e.message === item.seq).at(-1)}
                  ping={ping}
                />
              )}
            </Fragment>
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
        {working && stalled && (
          <p class="bubble agent stalled">
            No agent answered.{" "}
            {canPost && question && (
              <button type="button" class="retry" disabled={sending} onClick={() => void post(question, false)}>
                Try again
              </button>
            )}
          </p>
        )}
        {working && !stalled && (
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
      {/* Not while the agent works: the answer coming has the room. */}
      {canPost && studyId && !working && left.length > 0 && (
        <div class="suggestions">
          <p id="suggestions-title">Some things I can do</p>
          <ul aria-labelledby="suggestions-title">
            {left.map((suggestion) => (
              <li key={suggestion}>
                <button type="button" disabled={sending} onClick={() => void post(suggestion, false)}>
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* Between the log and the form, so its arrival moves nothing but the log's foot. */}
      <p class={notice?.startsWith("The simulator") ? "refusal ok" : "refusal"} role="status">
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
          <button type="submit" aria-label="Send" disabled={!text.trim() || !studyId || sending}>
            <SendIcon />
          </button>
        </form>
      )}
    </aside>
  );
}
