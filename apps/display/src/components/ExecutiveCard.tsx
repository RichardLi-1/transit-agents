// Under an answer that ends "Executive decision required: …": the decision, and a
// planner's button that pings the executive on Slack. Once pinged, every viewer's
// chat says so, from the log.
import { useEffect, useRef, useState } from "preact/hooks";
import { EXECUTIVE, executiveDecision } from "@transit-agents/contracts";
import { api } from "../api.ts";
import { refusal } from "../notice.ts";
import type { EscalationItem } from "../store.ts";
import { TIME_ZONE } from "../time.ts";
import { CheckIcon } from "./icons.tsx";

// Who a ping goes to: the executive's name, null when Slack isn't set up, and
// undefined until the service says. can: the viewer is a planner.
export type Ping = { to: string | null | undefined; can: boolean };

const clock = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

// An answer's text without its executive line, which the card shows instead.
export function withoutExecutive(text: string): string {
  const rest = text
    .split("\n")
    .filter((line) => !EXECUTIVE.test(line))
    .join("\n")
    .trimEnd();
  return rest || text;
}

// A speech bubble with a hash in it: Slack-ish, not Slack's mark.
const PingIcon = () => (
  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
    <path
      d="M6 4.5h12a2.500 2.500 0 0 1 2.500 2.500v8a2.500 2.500 0 0 1-2.500 2.500h-6.500L7 21v-3.500H6A2.500 2.500 0 0 1 3.500 15V7A2.500 2.500 0 0 1 6 4.500z"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linejoin="round"
    />
    <path d="M10.500 7.500l-1 7M14.500 7.500l-1 7M8 9.500h8M7.500 12.500h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
  </svg>
);

type Props = { studyId: string; seq: number; text: string; sent: EscalationItem | undefined; ping: Ping };

export function ExecutiveCard({ studyId, seq, text, sent, ping }: Props) {
  const decision = executiveDecision(text);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // This viewer's own ping, until the log's entry for it arrives.
  const [mine, setMine] = useState<{ to: string; at: string } | null>(null);
  const done = sent ?? mine;
  const said = useRef<HTMLParagraphElement>(null);
  // The button goes once the ping is sent, so focus moves to the line that says so.
  useEffect(() => {
    if (mine) said.current?.focus();
  }, [mine]);
  const label = `exec-${seq}`;

  const send = async () => {
    if (sending) return;
    setSending(true);
    setError(null);
    const response = await api(`/v1/studies/${encodeURIComponent(studyId)}/escalate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: (decision ?? "Executive decision required").slice(0, 300), message: seq }),
    }).catch(() => undefined);
    setSending(false);
    if (response?.ok) {
      const body = (await response.json().catch(() => null)) as { to?: string; at?: string } | null;
      setMine({ to: body?.to ?? ping.to ?? "", at: body?.at ?? new Date().toISOString() });
      return;
    }
    if (response?.status === 503) return setError("Slack isn't set up.");
    setError(response ? ((await refusal(response)) ?? "Not sent. Try again.") : "Not sent: the service can't be reached. Try again.");
  };

  return (
    <div class="exec-card" role="group" aria-labelledby={label} data-seq={seq}>
      <p class="exec-label" id={label}>
        Executive decision required
      </p>
      {decision && <p class="exec-decision">{decision}</p>}
      {done ? (
        <p class="exec-sent" ref={said} tabIndex={-1}>
          <span class="exec-check" aria-hidden="true">
            <CheckIcon />
          </span>
          {`Pinged ${done.to} on Slack · ${clock.format(new Date(done.at))}`}
        </p>
      ) : ping.to === null ? (
        <p class="exec-note">Slack isn't set up</p>
      ) : ping.to === undefined ? null : (
        <>
          {ping.can && <p class="exec-offer">I can ping {ping.to} on Slack for you.</p>}
          <button
            type="button"
            class="exec-ping"
            disabled={!ping.can}
            aria-disabled={sending || undefined}
            onClick={() => void send()}
          >
            <PingIcon />
            {!ping.can ? `Sign in to ping ${ping.to}` : sending ? `Pinging ${ping.to}…` : `Ping ${ping.to} on Slack`}
          </button>
          {error && (
            <p class="exec-error" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
