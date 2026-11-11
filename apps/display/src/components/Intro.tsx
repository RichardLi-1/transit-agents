// The opening card: what this demo is, in a few lines, the first time the app opens.
// A native modal dialog, so focus stays in it and Escape closes it.
import { useEffect, useRef, useState } from "preact/hooks";
import { markIntroSeen, SHOW_INTRO, shouldShowIntro } from "../intro.ts";
import { LineIcon } from "./icons.tsx";

const POINTS: [icon: string, title: string, words: string][] = [
  ["studies", "Ask in plain words", "A lead agent splits the work among specialists for standards, business cases, maps and safety."],
  ["study", "Every figure cited", "Open any number to see the page it came from."],
  ["account", "Planners decide", "Agents hand every judgement to a person."],
];

export function Intro() {
  const [open, setOpen] = useState(() => shouldShowIntro(location.search));
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(SHOW_INTRO, show);
    return () => window.removeEventListener(SHOW_INTRO, show);
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);
  const close = () => {
    markIntroSeen();
    setOpen(false);
  };
  return (
    <dialog ref={dialog} class="intro" aria-labelledby="intro-title" aria-describedby="intro-lead" onClose={close}>
      <svg class="brand" viewBox="0 0 32 32" width="40" height="40" aria-hidden="true">
        <path d="M8.400 25.300h7L26.900 13.800v-3.700" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" />
        <circle cx="5.100" cy="25.300" r="3.300" fill="none" stroke="currentColor" stroke-width="2.800" />
        <circle cx="26.900" cy="6.800" r="3.300" fill="none" stroke="currentColor" stroke-width="2.800" />
      </svg>
      <h1 id="intro-title">Transit Agents</h1>
      <p id="intro-lead" class="lead">AI agents that do the first pass of a transit study, from the documents and data planners already use.</p>
      <ul>
        {POINTS.map(([icon, title, words]) => (
          <li key={title}>
            <span class="mark" aria-hidden="true">
              <LineIcon name={icon} size={18} />
            </span>
            <span>
              <strong>{title}</strong>
              <span class="words">{words}</span>
            </span>
          </li>
        ))}
      </ul>
      <p class="note">A demo on public TTC, Metrolinx and City of Toronto data.</p>
      <form method="dialog">
        <button type="submit" class="start" autofocus>
          Explore the demo
        </button>
      </form>
    </dialog>
  );
}
