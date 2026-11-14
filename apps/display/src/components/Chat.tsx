// The chat, always beside the workspace: what the planner asked, and the agents at
// work, a line each: the lead's plan, each specialist it asked with how it went,
// and a run of the lead's own tool calls. Each opens to show more: the plan's
// questions, a specialist's answer and the tools it called, what a call was
// called with. The answer is what stands out.
import { Fragment } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { EXECUTIVE, type ModelChoices } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { spentUsd } from "../money.ts";
import { withCites } from "../cites.ts";
import { echoesDocument } from "../echo.ts";
import { refusal, setNotice, unsaid, useNotice } from "../notice.ts";
import { keepPins, pinLine, readPins, togglePin, type Pins } from "../pins.ts";
import { plain, plainBold } from "../plain.ts";
import { elapsed, specialistState, type Run } from "../runs.ts";
import { duration, foldRuns, grouped, planOf, stepName, stepState, togetherState, type Grouped, type StepState, type ToolStep } from "../steps.ts";
import { EMPTY_USAGE, type Store, type Subagent } from "../store.ts";
import { guideHidden, guideStep, hideGuide, MORE, unasked, withAsked, type Asked } from "../suggestions.ts";
import { foldAt, waiting } from "../typing.ts";
import { askedModel } from "../models.ts";
import { DocumentCard } from "./DocumentCard.tsx";
import { ExecutiveCard, withoutExecutive, type Ping } from "./ExecutiveCard.tsx";
import { CheckIcon, CrossIcon, LineIcon, SendIcon, StaleIcon } from "./icons.tsx";
import { RunLine, useNow } from "./RunLine.tsx";

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
  // Shows the intersection simulator, replaying a run, in its tab.
  onSimulator: () => void;
  // The models the service offers, one of which the viewer may have chosen in Settings.
  models?: ModelChoices;
};

const BADGE: Record<StepState, string> = { running: "Working", done: "Complete", failed: "Failed", stopped: "Stopped" };

// A step's mark: turning while it works, a tick once it's complete, a cross or a dash otherwise.
function Mark({ state }: { state: StepState }) {
  return (
    <span class="mark" data-state={state} aria-hidden="true">
      {state === "done" ? <CheckIcon /> : state === "failed" ? <CrossIcon /> : state === "stopped" ? <StaleIcon /> : null}
    </span>
  );
}

const Badge = ({ state }: { state: StepState }) => (
  <span class="badge" data-state={state}>
    {BADGE[state]}
  </span>
);

// One tool call: its name and how it went, and, opened, what it was called with,
// what came back and how long it took.
function ToolRow({ step, open }: { step: ToolStep; open: boolean }) {
  const state = stepState(step, open);
  return (
    <details class="step tool" data-state={state}>
      <summary>
        <Mark state={state} />
        <span class="step-name">{stepName(step.name)}</span>
        <Badge state={state} />
      </summary>
      <dl class="step-detail">
        {step.summary && (
          <>
            <dt>Input</dt>
            <dd>{step.summary}</dd>
          </>
        )}
        {step.result && (
          <>
            <dt>Result</dt>
            <dd>{step.result}</dd>
          </>
        )}
        {step.ms !== undefined && (
          <>
            <dt>Time</dt>
            <dd>{duration(step.ms)}</dd>
          </>
        )}
        <dt>Tool</dt>
        <dd>
          <code>{step.name}</code>
        </dd>
      </dl>
    </details>
  );
}

// A specialist the lead asked: a line with its question and how it's going, which
// opens to its answer once it's back, its skill, and the tools it called.
function Specialist({ item, run, open, now, ids, onPage }: { item: Grouped<Subagent>; run: Run | null; open: boolean; now: number; ids: string[]; onPage: Props["onPage"] }) {
  const tracked = run?.specialists.find((s) => s.id === item.id);
  const followed = tracked && run ? specialistState(tracked, run, now) : null;
  const state: StepState =
    item.summary !== undefined ? (item.ok === false ? "stopped" : "done") : followed === "stale" || (!open && !followed) ? "stopped" : "running";
  const meta = [
    tracked && elapsed(tracked.startedAt, tracked.finishedAt ?? now),
    tracked?.tokens ? `${number.format(tracked.tokens)} tokens` : null,
    item.tools.length ? `${item.tools.length} ${item.tools.length === 1 ? "tool call" : "tool calls"}` : null,
  ].filter(Boolean);
  return (
    <details class="step specialist" data-state={state}>
      <summary>
        <Mark state={state} />
        <span class="step-name">{item.question}</span>
        <Badge state={state} />
      </summary>
      <div class="step-body">
        {item.summary && (
          <p class="step-summary">
            <Text text={item.summary} ids={ids} onPage={onPage} />
          </p>
        )}
        {(meta.length > 0 || tracked?.skill) && (
          <p class="step-meta">
            {tracked?.skill && (
              <span class="skill">
                <span class="sr-only">Skill </span>
                {tracked.skill}
              </span>
            )}
            {meta.join(" · ")}
          </p>
        )}
        {item.tools.length > 0 && (
          <ol class="tool-list" aria-label="Tool calls">
            {item.tools.map((step) => (
              <li key={step.id}>
                <ToolRow step={step} open={open} />
              </li>
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}

// A run of the lead's own calls, side by side in the log, as one line that opens to each.
function ToolRun({ run, open }: { run: ToolStep[]; open: boolean }) {
  const state = togetherState(run.map((step) => stepState(step, open)));
  return (
    <details class="step tools" data-state={state}>
      <summary>
        <Mark state={state} />
        <span class="step-name">{`${run.length} tool calls`}</span>
        <Badge state={state} />
      </summary>
      <div class="step-body">
        <ol class="tool-list" aria-label="Tool calls">
          {run.map((step) => (
            <li key={step.id}>
              <ToolRow step={step} open={open} />
            </li>
          ))}
        </ol>
      </div>
    </details>
  );
}

// The lead's plan, folded to one line, "Plan · 5 questions", that opens to them.
function Plan({ seq, text, replay, ids, onPage }: { seq: number; text: string; replay: boolean; ids: string[]; onPage: Props["onPage"] }) {
  const steps = planOf(text)?.steps.length ?? 0;
  return (
    <details class="step plan-step" data-seq={seq}>
      <summary>
        <span class="mark plan-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="14" height="14">
            <path d="M9 6.5h10M9 12h10M9 17.5h10M4.5 6.5h.5M4.5 12h.5M4.5 17.5h.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </span>
        {replay && <span class="sr-only">Replay: </span>}
        <span class="step-name">{`Plan · ${steps} ${steps === 1 ? "question" : "questions"}`}</span>
      </summary>
      <div class="plan-body">
        <Words text={text} ids={ids} onPage={onPage} />
      </div>
    </details>
  );
}

// An agent's words at rest: a plan's numbered list as a list, anything else as written.
function Words({ text, ids, onPage }: { text: string; ids: string[]; onPage: Props["onPage"] }) {
  const plan = planOf(text);
  if (!plan) return <Text text={text} ids={ids} onPage={onPage} />;
  return (
    <>
      {plan.lead && (
        <span class="plan-lead">
          <Text text={plan.lead} ids={ids} onPage={onPage} />
        </span>
      )}
      <ol class="plan">
        {plan.steps.map((step, i) => (
          <li key={i}>
            <Text text={step} ids={ids} onPage={onPage} />
          </li>
        ))}
      </ol>
      {plan.after && (
        <span class="plan-after">
          <Text text={plan.after} ids={ids} onPage={onPage} />
        </span>
      )}
    </>
  );
}

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

// The lead's answer to an ask for the simulator, where no machine can drive it for
// the viewer: the display opens it from that line, for the viewer to try.
const SIMULATOR_LINE = /^Opening the intersection simulator:/;
const simulator = (message: { from: string; text: string }) => message.from === "agent" && SIMULATOR_LINE.test(message.text.trim());

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

export function Chat({ store, studyId, canPost, ping, onPage, onSimulator, models }: Props) {
  const ids = store.contexts.map((context) => context.id);
  const [text, setText] = useState("");
  // Whether the earlier messages show, and the studies the viewer has said something in.
  const [expanded, setExpanded] = useState(false);
  const [asked, setAsked] = useState<Asked>(readAsked);
  // More's suggestions shown too, after the first four.
  const [showMore, setShowMore] = useState(false);
  // The first visit's tips, until the viewer hides them in this browser.
  const [guideOff, setGuideOff] = useState(guideHidden);
  const [sending, setSending] = useState(false);
  // The messages this viewer has pinned, theirs alone, and one to scroll to.
  const [pins, setPins] = useState<Pins>(readPins);
  const [jumpTo, setJumpTo] = useState<number | null>(null);
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
      // A plan shows folded to its line, so it never types out.
      streams.current.set(m.seq, m.from === "agent" && !m.replay && store.since !== null && m.seq > store.since && m.studyId === studyId && !planOf(m.text));
    }
  }
  const messages = store.messages.filter((m) => m.studyId === studyId);
  const pinnedSeqs = (studyId && pins[studyId]) || [];
  const pinned = pinnedSeqs.flatMap((seq) => messages.filter((m) => m.seq === seq));
  const pin = (seq: number) => {
    if (!studyId) return;
    setPins((now) => {
      const next = togglePin(now, studyId, seq);
      keepPins(next);
      return next;
    });
  };
  const subagents = store.subagents.filter((s) => s.studyId === studyId);
  const documents = store.documents.filter((d) => d.studyId === studyId);
  const escalations = store.escalations.filter((e) => e.studyId === studyId);
  // An answer that types out shows its executive card once it's whole.
  const [, typed] = useState(0);
  const tools = store.tools.filter((t) => t.studyId === studyId);
  // Messages, sub-agents and documents in the order the log has them.
  const items = [...messages, ...subagents, ...documents].sort((a, b) => a.seq - b.seq);
  // Whether any of this study's chat is the scripted replay's, whatever came after.
  const replay = items.some((item) => item.replay);
  const agentRun = (studyId && store.runs[studyId]) || null;
  const now = useNow(Boolean(agentRun && !agentRun.finishedAt));
  // The open study's spend, not every study's.
  const usage = (studyId && store.usage[studyId]) || EMPTY_USAGE;
  const spent = spentUsd(usage);
  const notice = useNotice();
  const run = studyId ? store.openRuns[studyId] : undefined;
  // The agent is at work: a run has started and not answered, or a question is waiting for one.
  const working = waiting(run, items, store.since);
  // Anything the agent does: a word, a sub-agent's step, a run starting or ending,
  // a model call or a page read. Each puts off saying it has stopped.
  const pulse = [studyId, items.length, subagents.filter((s) => s.summary !== undefined).length, tools.length, tools.filter((t) => t.ok !== undefined).length, run, usage.calls, store.reading].join("|");
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
  // A pinned message folded under Earlier opens it, then scrolls to the message.
  const jump = (seq: number) => {
    if (seq <= since) setExpanded(true);
    setJumpTo(seq);
  };
  useEffect(() => {
    if (jumpTo === null) return;
    const found = log.current?.querySelector<HTMLElement>(`[data-seq="${jumpTo}"]`);
    setJumpTo(null);
    if (!found) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    found.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    found.setAttribute("tabindex", "-1");
    found.focus({ preventScroll: true });
    found.classList.add("flash");
    window.setTimeout(() => found.classList.remove("flash"), 1600);
  }, [jumpTo, expanded]);
  const urls = documents.map((d) => d.url);
  // The lead's "Document ready" line repeats its document's card, so only the card shows.
  const kept = (expanded ? items : items.filter((item) => item.seq > since)).filter(
    (item) => !("text" in item && item.from === "agent" && echoesDocument(item.text, urls)),
  );
  // Each specialist with the tools it called, and the lead's own calls where they
  // come, a run of them side by side as one line.
  const shown = foldRuns(
    grouped(
      kept.filter((item): item is Exclude<(typeof kept)[number], Subagent> => !("question" in item)),
      kept.filter((item): item is Subagent => "question" in item),
      tools.filter((t) => expanded || t.seq > since),
    ),
    (item): item is ToolStep => !("url" in item) && !("text" in item) && !("question" in item),
  );
  const open = run !== undefined;
  const question = messages.filter((m) => m.from === "planner").at(-1)?.text;
  // Things to ask, only while the chat shows nothing yet.
  const left = studyId && !shown.length ? unasked(asked, studyId) : [];
  const more = studyId && !shown.length ? unasked(asked, studyId, MORE) : [];
  // The first visit's path: what to try first, and after each answer, what next.
  const guide = studyId && !guideOff ? guideStep(asked, studyId) : null;
  const first = guide?.next && left.includes(guide.next) ? guide.next : null;
  const offered = (showMore ? [...left, ...more] : left).filter((suggestion) => suggestion !== first);
  const after = guide && shown.length > 0 && !working && (guide.next || guide.look) ? guide : null;

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
  useLayoutEffect(toFoot, [studyId, notice, working, offered.length, after?.next, after?.look]);
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
    setSending(true);
    if (typed) setText("");
    atFoot.current = true;
    const response = await api(`/v1/studies/${studyId}/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The model chosen in Settings, if any: the agents answer on it.
      body: JSON.stringify({ kind: "message", text: trimmed, model: askedModel(models) }),
    }).catch(() => undefined);
    setSending(false);
    if (response?.ok) {
      setAsked((now) => keepAsked(withAsked(now, studyId, trimmed)));
      setShowMore(false);
      return setNotice(null);
    }
    setText((now) => now || trimmed);
    const reason = response ? ((await refusal(response)) ?? "Not sent. Try again.") : "Not sent: the service can't be reached. Try again.";
    setNotice(unsaid(reason, messages.at(-1)?.text));
  };

  return (
    <aside id="chat" class="chat" aria-labelledby="chat-title">
      <header class="chat-head">
        <h2 id="chat-title">Chat</h2>
        {replay && <p class="tag">Replay</p>}
        <RunLine run={agentRun} study={store.studies.find((s) => s.id === studyId)?.title ?? studyId ?? ""} />
      </header>
      {/* Always here, empty when nothing is pinned, so the chat's rows keep their places. */}
      <div class="pins">
        {pinned.length > 0 && (
          <section aria-label="Pinned messages">
            <ul>
              {pinned.map((m) => (
                <li key={m.seq}>
                  <button type="button" class="pin-jump" onClick={() => jump(m.seq)}>
                    <LineIcon name="pin" size={14} />
                    <span>{pinLine(m.text)}</span>
                  </button>
                  <button type="button" class="pin-off" aria-label={`Unpin: ${pinLine(m.text, 40)}`} onClick={() => pin(m.seq)}>
                    <CrossIcon />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <div class="log" ref={log} role="log" aria-live="polite" tabIndex={0} aria-label="Agent activity" onScroll={onScroll}>
        {earlier > 0 && (
          <button type="button" class="earlier" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
            {expanded ? "Hide earlier messages" : `Earlier: ${number.format(earlier)} ${earlier === 1 ? "message" : "messages"}`}
          </button>
        )}
        {shown.map((item) =>
          "run" in item ? (
            <ToolRun key={`r${item.run[0]?.id}`} run={item.run} open={open} />
          ) : "url" in item ? (
            <DocumentCard key={`d${item.seq}`} document={item} />
          ) : "text" in item && item.from === "agent" && planOf(item.text) ? (
            <Plan key={`m${item.seq}`} seq={item.seq} text={item.text} replay={Boolean(item.replay)} ids={ids} onPage={onPage} />
          ) : "text" in item ? (
            <Fragment key={`m${item.seq}`}>
              <div class={`bubble ${item.from}${pinnedSeqs.includes(item.seq) ? " pinned" : ""}`} data-seq={item.seq}>
                {item.replay && <span class="sr-only">Replay: </span>}
                {studyId && !streams.current.get(item.seq) && (
                  <button
                    type="button"
                    class="pin-toggle"
                    aria-pressed={pinnedSeqs.includes(item.seq)}
                    aria-label="Pin"
                    title={pinnedSeqs.includes(item.seq) ? "Unpin" : "Pin"}
                    onClick={() => pin(item.seq)}
                  >
                    <LineIcon name="pin" size={15} />
                  </button>
                )}
                {streams.current.get(item.seq) ? (
                  <Streamed
                    text={executive(item) ? withoutExecutive(item.text) : item.text}
                    ids={ids}
                    onPage={onPage}
                    onDone={() => {
                      if (streams.current.get(item.seq)) {
                        typed((n) => n + 1);
                        // An answer that arrived live opens the simulator itself, in its tab.
                        if (simulator(item)) onSimulator();
                      }
                      streams.current.set(item.seq, false);
                    }}
                  />
                ) : item.from === "agent" ? (
                  <Words text={executive(item) ? withoutExecutive(item.text) : item.text} ids={ids} onPage={onPage} />
                ) : (
                  <Text text={item.text} ids={ids} onPage={onPage} />
                )}
              </div>
              {simulator(item) && !streams.current.get(item.seq) && (
                <div class="doc-card sim-card">
                  <p>
                    <span class="doc-title">Intersection Simulator 4.2</span>
                    <span class="doc-kind">Don Mills & Eglinton, sample data</span>
                  </p>
                  <button type="button" class="doc-open" onClick={onSimulator}>
                    Open the simulator
                  </button>
                </div>
              )}
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
          ) : "question" in item ? (
            <Specialist key={`s${item.id}`} item={item} run={agentRun} open={open} now={now} ids={ids} onPage={onPage} />
          ) : (
            <ToolRow key={`t${item.id}`} step={item} open={open} />
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
      {/* Only while the chat is empty, and not while the agent works: the answer coming has the room. */}
      {canPost && studyId && !working && left.length + more.length > 0 && (
        <div class="suggestions">
          {first && (
            <>
              <div class="suggestions-head">
                <p id="suggestions-first">Try this first</p>
              </div>
              <ul aria-labelledby="suggestions-first" class="first">
                <li>
                  <button type="button" disabled={sending} onClick={() => void post(first, false)}>
                    {first}
                  </button>
                </li>
              </ul>
            </>
          )}
          <div class="suggestions-head">
            <p id="suggestions-title">{first ? "Then" : "Some things I can do"}</p>
            {more.length > 0 && (
              <button
                type="button"
                class="suggestions-more"
                aria-expanded={showMore}
                aria-controls="suggestions-list"
                onClick={() => setShowMore((now) => !now)}
              >
                {showMore ? "Fewer" : "More"}
              </button>
            )}
          </div>
          <ul id="suggestions-list" aria-labelledby="suggestions-title" class={showMore ? "all" : undefined}>
            {offered.map((suggestion) => (
              <li key={suggestion}>
                <button type="button" disabled={sending} onClick={() => void post(suggestion, false)}>
                  {suggestion}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {/* After an answer, while the guide lasts: what to look at in it, and what to try next. */}
      {canPost && after && (
        <div class="guide">
          <div class="guide-body">
            {after.look && <p class="guide-look">{after.look}</p>}
            {after.next && (
              <div class="guide-next">
                <span id="guide-next">Try next</span>
                <button type="button" aria-describedby="guide-next" disabled={sending} onClick={() => void post(after.next as string, false)}>
                  {after.next}
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            class="guide-hide"
            aria-label="Hide these tips"
            onClick={() => {
              hideGuide();
              setGuideOff(true);
            }}
          >
            <CrossIcon />
          </button>
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
          <button type="submit" aria-label="Send" disabled={!text.trim() || !studyId || sending}>
            <SendIcon />
          </button>
        </form>
      )}
    </aside>
  );
}
