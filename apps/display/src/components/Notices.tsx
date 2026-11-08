// What needs a planner, as it happens: a toast for each new notice, and a bell that
// lists the recent ones. Toasts never take focus, and one polite live region reads
// each out. Sound and browser notifications are each the planner's to turn on.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { StudyView } from "@transit-agents/contracts";
import { chime, listenForUse, wake } from "../chime.ts";
import { spokenTogether, type Notice } from "../notify.ts";
import { overflow } from "../toasts.ts";

// At most this many toasts at once, each for this long while nothing holds it.
// A phone, as styles.css lays it out, has room for one.
const SHOWN = 3;
const PHONE = "(max-width: 860px)";
const SHOW_MS = 8000;
const LEAVE_MS = 260;
// After a new study's title has had time to load.
const SAY_MS = 300;
const CHIME = "transit-chime";
const ALERTS = "transit-alerts";

const time = new Intl.DateTimeFormat("en-CA", { hour: "numeric", minute: "2-digit" });
const reduced = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const alertsExist = () => typeof Notification !== "undefined";

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "on";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean) {
  try {
    if (on) localStorage.setItem(key, "on");
    else localStorage.removeItem(key);
  } catch {}
}

const stroke = { fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" } as const;

function Glyph({ notice }: { notice: Notice }) {
  const path = (() => {
    switch (notice.kind) {
      case "finding":
      case "handover":
        // The hollow ring the card shows on what awaits a planner.
        return <circle cx="12" cy="12" r="5.5" {...stroke} stroke-width="2.6" />;
      case "decision":
        return <path d="M6 12.5l4 4 8-9" {...stroke} stroke-width="2.6" />;
      case "need":
        return (
          <>
            <path d="M12 20.5s-6-5.600-6-10.500a6 6 0 0 1 12 0c0 4.900-6 10.500-6 10.500z" {...stroke} />
            <circle cx="12" cy="10" r="2" fill="currentColor" />
          </>
        );
      case "media":
        return notice.target.kind === "media" && notice.target.media === "video" ? (
          <path d="M9 7.500v9l7.500-4.500z" fill="currentColor" />
        ) : (
          <>
            <rect x="4.500" y="6" width="15" height="12" rx="2" {...stroke} />
            <path d="M5 16l4-4 3 3 2-2 5 4" {...stroke} />
          </>
        );
      case "answer":
        return <path d="M5 6.500h14v9H10l-4 3v-3H5z" {...stroke} />;
    }
  })();
  return (
    <span class="glyph" data-kind={notice.kind} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="18" height="18">
        {path}
      </svg>
    </span>
  );
}

function Line({ notice }: { notice: Notice }) {
  return (
    <span class="line">
      {notice.text}
      {notice.count > 1 && (
        <span class="count">
          {notice.count}
          <span class="sr-only"> notes</span>
        </span>
      )}
    </span>
  );
}

const BellIcon = () => (
  <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <path d="M6 16.500V11a6 6 0 0 1 12 0v5.500l1.500 1.500h-15z" {...stroke} stroke-width="2" />
    <path d="M10 20.500a2.200 2.200 0 0 0 4 0" {...stroke} stroke-width="2" />
  </svg>
);

type ToastProps = {
  notice: Notice;
  title: string;
  held: boolean;
  leaving: boolean;
  onDone: (id: number) => void;
  onReview: (notice: Notice) => void;
};

function Toast({ notice, title, held, leaving, onDone, onReview }: ToastProps) {
  // What's left of its time, which runs only while nothing holds the toasts.
  const left = useRef(SHOW_MS);
  const seq = useRef(notice.seq);
  const done = useRef(onDone);
  done.current = onDone;

  useEffect(() => {
    // A finding folded into it shows it afresh.
    if (seq.current !== notice.seq) {
      seq.current = notice.seq;
      left.current = SHOW_MS;
    }
    if (held || leaving) return;
    const started = Date.now();
    const timer = window.setTimeout(() => done.current(notice.id), Math.max(0, left.current));
    return () => {
      clearTimeout(timer);
      left.current -= Date.now() - started;
    };
  }, [held, leaving, notice.seq, notice.id]);

  const words = `toast-${notice.id}`;
  return (
    <li class={leaving ? "toast leaving" : "toast"} data-id={notice.id}>
      <Glyph notice={notice} />
      <p class="words" id={words}>
        <Line notice={notice} />
        <span class="study">{title}</span>
      </p>
      <button type="button" class="review" aria-describedby={words} onClick={() => onReview(notice)}>
        Review
      </button>
    </li>
  );
}

type Props = {
  notices: Notice[];
  studies: StudyView[];
  // A source page or the engagement viewer is open. Either hides the rest of the
  // page from assistive technology, so the toasts wait for it to close, and so
  // do their words.
  covered: boolean;
  onReview: (notice: Notice) => void;
};

type Shown = { id: number; leaving: boolean };

export function Notices({ notices, studies, covered, onReview }: Props) {
  const [toasts, setToasts] = useState<Shown[]>([]);
  const [open, setOpen] = useState(false);
  // Each notice's seq when the planner last saw it: a notice is unread until then.
  const [read, setRead] = useState<ReadonlyMap<number, number>>(new Map());
  // Unread when the list opened, so the list can mark them.
  const [fresh, setFresh] = useState<ReadonlySet<number>>(new Set());
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  const [said, setSaid] = useState("");
  const [rings, setRings] = useState(0);
  const [sound, setSound] = useState(() => readFlag(CHIME));
  const [alerts, setAlerts] = useState(() => readFlag(ALERTS) && alertsExist() && Notification.permission === "granted");
  const [denied, setDenied] = useState(() => alertsExist() && Notification.permission === "denied");

  const root = useRef<HTMLDivElement>(null);
  const bell = useRef<HTMLButtonElement>(null);
  const stack = useRef<HTMLOListElement>(null);
  const known = useRef(new Set<number>());
  const handled = useRef(0);
  const tops = useRef(new Map<number, number>());

  const titleOf = (studyId: string) => studies.find((s) => s.id === studyId)?.title ?? studyId;
  // For what's said a moment after the notice, by when a new study has its title.
  const latest = useRef({ titleOf, sound, alerts, onReview });
  latest.current = { titleOf, sound, alerts, onReview };

  useEffect(() => listenForUse(), []);

  useEffect(() => {
    const change = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);

  const markRead = (list: Notice[]) => setRead((before) => new Map([...before, ...list.map((n) => [n.id, n.seq] as const)]));

  const shownNow = useRef(toasts);
  shownNow.current = toasts;

  // The toast with keyboard focus, if one has it.
  const holding = () => {
    const active = document.activeElement;
    const item = active && stack.current?.contains(active) ? active.closest<HTMLElement>("li") : null;
    return item ? Number(item.dataset.id) : undefined;
  };

  // What's still to say. Notices that come together are said together, a moment
  // after the last of them, as one change to the live region: changes that close
  // together can reach a screen reader as only the last of them.
  const unsaid = useRef<Notice[]>([]);
  const saying = useRef(0);

  const coveredNow = useRef(covered);
  coveredNow.current = covered;

  const say = () => {
    if (coveredNow.current) return;
    const text = spokenTogether(unsaid.current.splice(0), latest.current.titleOf);
    // The same words again still read out.
    if (text) setSaid((before) => (before === text ? `${text}\u00a0` : text));
  };

  const leave = (ids: number[]) => {
    if (!ids.length) return;
    setToasts((all) => all.map((t) => (ids.includes(t.id) ? { ...t, leaving: true } : t)));
    // Unless it was shown again meanwhile.
    window.setTimeout(() => setToasts((all) => all.filter((t) => !(t.leaving && ids.includes(t.id)))), reduced() ? 0 : LEAVE_MS);
  };

  // New notices, and findings folded into one already shown.
  useEffect(() => {
    const changed = notices.filter((n) => n.seq > handled.current);
    if (!changed.length) return;
    handled.current = Math.max(...changed.map((n) => n.seq));
    const added = changed.filter((n) => !known.current.has(n.id));
    for (const n of added) known.current.add(n.id);

    if (open) {
      // The open list shows them.
      markRead(changed);
      setFresh((before) => new Set([...before, ...changed.map((n) => n.id)]));
    } else {
      // Newest on top. A finding folded into a toast that has gone shows it again.
      const all = shownNow.current;
      const showing = new Set(all.filter((t) => !t.leaving).map((t) => t.id));
      const toShow = new Set(changed.filter((n) => !showing.has(n.id)).map((n) => n.id));
      if (toShow.size) {
        const next = [...[...toShow].reverse().map((id) => ({ id, leaving: false })), ...all.filter((t) => !toShow.has(t.id))];
        setToasts(next);
        const room = window.matchMedia(PHONE).matches ? 1 : SHOWN;
        leave(overflow(next.filter((t) => !t.leaving).map((t) => t.id), holding(), room));
      }
    }
    if (!added.length) return;
    setRings((n) => n + 1);
    if (latest.current.sound) chime();
    unsaid.current.push(...added);
    clearTimeout(saying.current);
    saying.current = window.setTimeout(say, SAY_MS);
    const newest = added.at(-1) as Notice;
    window.setTimeout(() => {
      const { titleOf: title, alerts: alerting, onReview: review } = latest.current;
      if (!alerting || document.visibilityState !== "hidden" || !alertsExist()) return;
      try {
        const alert = new Notification(newest.text, { body: title(newest.studyId), tag: `transit-${newest.id}` });
        alert.onclick = () => {
          window.focus();
          review(newest);
          alert.close();
        };
      } catch {}
    }, SAY_MS);
  }, [notices, open]);

  // What came while a source page was open, said a moment after it closes, once
  // the live region is back where a screen reader hears it.
  useEffect(() => {
    if (covered || !unsaid.current.length) return;
    clearTimeout(saying.current);
    saying.current = window.setTimeout(say, SAY_MS);
  }, [covered]);

  // Toasts below a new one slide down to make room, rather than jump.
  useLayoutEffect(() => {
    const list = stack.current;
    if (!list) return;
    const next = new Map<number, number>();
    for (const item of Array.from(list.children) as HTMLElement[]) {
      const id = Number(item.dataset.id);
      next.set(id, item.offsetTop);
      const before = tops.current.get(id);
      if (before !== undefined && before !== item.offsetTop && !reduced() && item.animate) {
        item.animate([{ transform: `translateY(${before - item.offsetTop}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
      }
    }
    tops.current = next;
  });

  // Nothing holds the toasts once they've all gone.
  useEffect(() => {
    if (toasts.length) return;
    setHovered(false);
    setFocused(false);
  }, [toasts.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  const unread = notices.filter((n) => read.get(n.id) !== n.seq);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    setFresh(new Set(unread.map((n) => n.id)));
    markRead(notices);
    leave(toasts.filter((t) => !t.leaving).map((t) => t.id));
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    bell.current?.focus();
  };

  const review = (notice: Notice) => {
    markRead([notice]);
    leave([notice.id]);
    setOpen(false);
    onReview(notice);
  };

  const switchSound = () => {
    const on = !sound;
    setSound(on);
    writeFlag(CHIME, on);
    if (!on) return;
    wake();
    chime();
  };

  const switchAlerts = async () => {
    if (alerts) {
      setAlerts(false);
      writeFlag(ALERTS, false);
      return;
    }
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setDenied(permission === "denied");
    setAlerts(permission === "granted");
    writeFlag(ALERTS, permission === "granted");
  };

  const shown = toasts.flatMap((t) => {
    const notice = notices.find((n) => n.id === t.id);
    return notice ? [{ ...t, notice }] : [];
  });
  const count = unread.length;

  return (
    <div class="notices" ref={root}>
      <button
        ref={bell}
        type="button"
        class={count ? "bell unread" : "bell"}
        aria-expanded={open}
        aria-controls="notice-list"
        onClick={toggle}
        onKeyDown={(event) => event.key === "Escape" && open && close()}
      >
        <span class={rings ? "swing" : undefined} key={rings}>
          <BellIcon />
        </span>
        <span class="sr-only">Notifications</span>
        {count > 0 && (
          <span class="badge">
            {count > 9 ? "9+" : count}
            <span class="sr-only"> unread</span>
          </span>
        )}
      </button>

      <div id="notice-list" class="notice-list" hidden={!open} onKeyDown={(event) => event.key === "Escape" && close()}>
        <h2 class="sr-only">Notifications</h2>
        {notices.length > 0 ? (
          <ol>
            {[...notices].reverse().map((notice) => (
              <li key={notice.id}>
                <button type="button" class="notice" onClick={() => review(notice)}>
                  <Glyph notice={notice} />
                  <span class="words">
                    <Line notice={notice} />
                    <span class="study">{titleOf(notice.studyId)}</span>
                  </span>
                  <time dateTime={notice.at}>{time.format(Date.parse(notice.at))}</time>
                  {fresh.has(notice.id) && (
                    <span class="dot">
                      <span class="sr-only">New</span>
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <p class="none">None yet</p>
        )}
        <div class="switches">
          <button type="button" role="switch" aria-checked={sound} onClick={switchSound}>
            <span class="knob" aria-hidden="true" />
            Chime
          </button>
          {alertsExist() && (
            <button type="button" role="switch" aria-checked={alerts} disabled={denied && !alerts} onClick={() => void switchAlerts()}>
              <span class="knob" aria-hidden="true" />
              Browser alerts
            </button>
          )}
        </div>
      </div>

      <ol
        ref={stack}
        class="toasts"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusIn={() => setFocused(true)}
        onFocusOut={(event) => {
          if (!stack.current?.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          leave(toasts.map((t) => t.id));
          bell.current?.focus();
        }}
      >
        {shown.map(({ id, leaving, notice }) => (
          <Toast
            key={id}
            notice={notice}
            title={titleOf(notice.studyId)}
            held={hovered || focused || hidden || covered}
            leaving={leaving}
            onDone={(done) => leave([done])}
            onReview={review}
          />
        ))}
      </ol>

      <p class="sr-only" aria-live="polite" aria-atomic="true">
        {said}
      </p>
    </div>
  );
}
