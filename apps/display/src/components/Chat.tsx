import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../api.ts";
import type { Store } from "../store.ts";
import { CheckIcon, SendIcon } from "./icons.tsx";

const number = new Intl.NumberFormat("en-CA");
const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function Chat({ store, studyId }: { store: Store; studyId: string | null }) {
  const [text, setText] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const messages = store.messages.filter((m) => m.studyId === studyId);
  const subagents = store.subagents.filter((s) => s.studyId === studyId);
  const { usage, replay } = store;

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
        {messages.map((message) => (
          <p key={message.seq} class={`bubble ${message.from}`}>
            {message.text}
          </p>
        ))}
        {subagents.map((sub) => (
          <div key={sub.id} class={sub.summary ? "sub done" : "sub"}>
            <span class="mark" aria-hidden="true">
              {sub.summary ? <CheckIcon /> : null}
            </span>
            <div>
              <p class="question">{sub.question}</p>
              {sub.summary && <p>{sub.summary}</p>}
            </div>
          </div>
        ))}
      </div>
      {usage.calls > 0 && (
        <p class="usage">
          {number.format(usage.inputTokens + usage.outputTokens)} tokens · {money.format(usage.costUsd)}
        </p>
      )}
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
    </aside>
  );
}
