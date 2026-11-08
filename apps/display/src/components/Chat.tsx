import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import { spentUsd } from "../money.ts";
import { withCites } from "../cites.ts";
import { plain } from "../plain.ts";
import { EMPTY_USAGE, type Store } from "../store.ts";
import { CheckIcon, SendIcon, StaleIcon } from "./icons.tsx";

const number = new Intl.NumberFormat("en-CA");
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

export function Chat({ store, studyId, canPost, onPage }: Props) {
  const ids = store.contexts.map((context) => context.id);
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const messages = store.messages.filter((m) => m.studyId === studyId);
  const subagents = store.subagents.filter((s) => s.studyId === studyId);
  // Messages and sub-agents in the order the log has them.
  const items = [...messages, ...subagents].sort((a, b) => a.seq - b.seq);
  // Whether any of this study's chat is the scripted replay's, whatever came after.
  const replay = items.some((item) => item.replay);
  // The open study's spend, not every study's.
  const usage = (studyId && store.usage[studyId]) || EMPTY_USAGE;
  const spent = spentUsd(usage);

  useEffect(() => {
    const element = log.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages.length, subagents]);

  const send = async (event: Event) => {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !studyId) return;
    setText("");
    await api(`/v1/studies/${studyId}/activity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "message", text: trimmed }),
    });
  };

  return (
    <aside class="chat" aria-label="Agent">
      {replay && <p class="tag">Replay</p>}
      <div class="log" ref={log} role="log" aria-live="polite" tabIndex={0} aria-label="Agent activity">
        {items.map((item) =>
          "text" in item ? (
            <p key={`m${item.seq}`} class={`bubble ${item.from}`}>
              {item.replay && <span class="sr-only">Replay: </span>}
              <Text text={item.text} ids={ids} onPage={onPage} />
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
      </div>
      {usage.calls > 0 && (
        <p class="usage">
          {number.format(usage.inputTokens + usage.outputTokens)} tokens{spent !== null && ` · ${money.format(spent)}`}
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
