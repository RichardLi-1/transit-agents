// The slim rail down the app's left edge: the studies, then what belongs to the
// app rather than a study: notifications, spend, the system page, settings and the account.
// Up and down move along it; a menu closes on Escape, giving focus back.
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { StudyView } from "@transit-agents/contracts";
import { studyColor } from "../map/views.ts";
import { isGuest, signIn, signOut, type Session } from "../session.ts";
import { readChoice, setChoice, type ThemeChoice } from "../theme.ts";
import { LineIcon } from "./icons.tsx";

type Props = {
  studies: StudyView[];
  studyId: string | null;
  session: Session | null;
  testBuild: boolean;
  onSelect: (id: string) => void;
  // The notifications bell and its list, which keep their own state.
  notices: ComponentChildren;
};

const ITEMS = ".rail-item";

// The app's mark, the icon's line with a stop at each end, in the words' colour:
// the line's own colour belongs to the map.
const BrandMark = () => (
  <svg class="brand" viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
    <path d="M8.400 25.300h7L26.900 13.800v-3.700" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round" />
    <circle cx="5.100" cy="25.300" r="3.300" fill="none" stroke="currentColor" stroke-width="2.800" />
    <circle cx="26.900" cy="6.800" r="3.300" fill="none" stroke="currentColor" stroke-width="2.800" />
  </svg>
);

// A study's state in a word, for its row in the list.
function stateOf(study: StudyView): string {
  if (study.decision) return { adopt: "Adopted", reject: "Not adopted", defer: "Deferred", amend: "Amended" }[study.decision.outcome];
  if (study.findings.some((f) => f.tone === "unrated") || study.checks.some((c) => c.status === "unverified")) return "Awaiting a planner";
  return "Open";
}

function Studies({ studies, studyId, onSelect }: Pick<Props, "studies" | "studyId" | "onSelect">) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    // A disclosure: the list follows its button in the tab order, and Escape closes it.
    <div class="rail-menu" onKeyDown={(event) => event.key === "Escape" && open && close()}>
      <button ref={button} type="button" class="rail-item" aria-expanded={open} aria-controls="study-list" onClick={() => setOpen(!open)}>
        <LineIcon name="studies" />
        <span class="rail-label">Studies</span>
      </button>
      <div id="study-list" ref={menu} class="popover studies-list" hidden={!open}>
        <h2 class="sr-only">Studies</h2>
        <ul>
          {studies.map((study) => (
            <li key={study.id}>
              <a
                href={`#${study.id}`}
                aria-current={study.id === studyId ? "page" : undefined}
                onClick={(event) => {
                  event.preventDefault();
                  onSelect(study.id);
                  close();
                }}
              >
                <span class="swatch" style={{ background: `#${studyColor(study.line)}` }} aria-hidden="true" />
                <span class="words">
                  <span class="name">{study.title}</span>
                  <span class="state">{stateOf(study)}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const APPEARANCE: [ThemeChoice, string][] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
];

// Settings: the viewer's own, kept in this browser. For now, light or dark.
function Settings() {
  const [open, setOpen] = useState(false);
  const [choice, setShown] = useState<ThemeChoice>(readChoice);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div class="rail-menu" onKeyDown={(event) => event.key === "Escape" && open && close()}>
      <button ref={button} type="button" class="rail-item" aria-expanded={open} aria-controls="settings" onClick={() => setOpen(!open)}>
        <LineIcon name="settings" />
        <span class="rail-label">Settings</span>
      </button>
      <div id="settings" ref={menu} class="popover settings" hidden={!open}>
        <h2>Settings</h2>
        <fieldset class="segmented">
          <legend>Appearance</legend>
          <div class="options">
            {APPEARANCE.map(([value, label]) => (
              <label key={value}>
                <input
                  type="radio"
                  name="appearance"
                  value={value}
                  checked={choice === value}
                  onChange={() => {
                    setChoice(value);
                    setShown(value);
                  }}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  );
}

function Account({ session }: { session: Session | null }) {
  if (!session) return null;
  const { config, me, anonymous, signedIn } = session;
  if (signedIn) {
    // Someone signed in who isn't a planner is named by their sandbox's id, which means nothing to them.
    const name = me && !isGuest(me) ? me.name : null;
    return (
      <button type="button" class="rail-item" title={name ?? undefined} onClick={() => void signOut()}>
        <LineIcon name="account" />
        <span class="rail-label">Sign out</span>
      </button>
    );
  }
  const login = anonymous ? (config?.signIn ?? null) : null;
  const demo = anonymous && (config?.auth === "demo" || config?.auth === "open");
  return (
    <>
      {demo && <p class="tag rail-tag">Demo</p>}
      {login && (
        <button type="button" class="rail-item" onClick={() => void signIn(login)}>
          <LineIcon name="account" />
          <span class="rail-label">Sign in</span>
        </button>
      )}
    </>
  );
}

export function Rail({ studies, studyId, session, testBuild, onSelect, notices }: Props) {
  const nav = useRef<HTMLElement>(null);
  // Up and down step through the rail's items, as in a toolbar.
  const step = (event: KeyboardEvent) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const target = event.target as HTMLElement;
    if (!target.matches(ITEMS)) return;
    const items = [...(nav.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = items.indexOf(target);
    const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
    const next = items[(at + (forward ? 1 : -1) + items.length) % items.length];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };
  return (
    <nav ref={nav} class="rail" aria-label="App" onKeyDown={step}>
      <BrandMark />
      <Studies studies={studies} studyId={studyId} onSelect={onSelect} />
      <div class="rail-foot">
        {notices}
        <a class="rail-item" href="/spend/">
          <LineIcon name="spend" />
          <span class="rail-label">Spend</span>
        </a>
        <a class="rail-item" href="/system/">
          <LineIcon name="system" />
          <span class="rail-label">System</span>
        </a>
        <Settings />
        <Account session={session} />
        {testBuild && <p class="tag rail-tag build">Test build</p>}
      </div>
    </nav>
  );
}
