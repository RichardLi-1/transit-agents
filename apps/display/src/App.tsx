import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CheckView, Context, FindingView, StudyView, Timeline } from "@transit-agents/contracts";
import { Chat } from "./components/Chat.tsx";
import { Files } from "./components/Files.tsx";
import { LineIcon } from "./components/icons.tsx";
import { MapView } from "./components/MapView.tsx";
import { Notices } from "./components/Notices.tsx";
import { QuickLook, type Opened } from "./components/QuickLook.tsx";
import { Intro } from "./components/Intro.tsx";
import { Rail } from "./components/Rail.tsx";
import { StudyPage } from "./components/StudyPage.tsx";
import { spatialLayer } from "./spatial.ts";
import { TimeBar } from "./components/TimeBar.tsx";
import { api } from "./api.ts";
import { isTestBuild } from "./host.ts";
import type { Notice } from "./notify.ts";
import { shownStudy } from "./preview.ts";
import { reveal } from "./reveal.ts";
import { canAdd, canCreate, canDecide, canPost, useSession } from "./session.ts";
import { Simulator } from "./simulator.ts";
import { useStore } from "./store.ts";
import { nextTab, TABS, tabFor, type Tab } from "./tabs.ts";
import { dateToMs } from "./time.ts";

type TraceNode = {
  id: string;
  label: string;
  value: number;
  unit: string;
  basis: { kind: string; citation?: { contextId: string; page: number; quote: string }; formula?: string; inputs?: Record<string, unknown> };
  entry?: { actor: string };
  inputs: (
    | TraceNode
    | { assumption: { key: string; label: string; value: number; unit: string; reason?: string; owner?: string; citation?: { contextId: string; page: number; quote: string } } }
  )[];
};

const decimal = new Intl.NumberFormat("en-CA", { maximumFractionDigits: 2 });
const OPERATORS: Record<string, string> = { "*": "×", "/": "÷", "-": "−" };

// A derived figure's formula, with each input's value in place of its name, and
// an input that is itself worked out written out in brackets, so every step shows.
function written(node: TraceNode): string | undefined {
  const { formula, inputs } = node.basis;
  if (!formula || !inputs) return undefined;
  const values = new Map(
    Object.keys(inputs).map((name, i) => {
      const input = node.inputs?.[i];
      if (!input) return [name, undefined];
      if ("assumption" in input) return [name, number(input.assumption.value)];
      const inner = written(input);
      return [name, inner ? `(${inner})` : number(input.value)];
    }),
  );
  return formula.replace(/[A-Za-z_]\w*|[*/-]/g, (token) => values.get(token) ?? OPERATORS[token] ?? token);
}

const number = (value: number) => (value < 0 ? `(−${decimal.format(-value)})` : decimal.format(value));

const FIRST_REVIEW_DAYS = 365;
const TEST_BUILD = isTestBuild(location.hostname);

// The study shown first. The others are a pick away, and new work takes the focus.
const LEAD = "ontario-line-don-mills";

// A phone, as styles.css lays it out: the chat is a tab of the workspace.
const PHONE = "(max-width: 860px)";
const TAB_KEY = "workspace.tab";

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE).matches);
  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const follow = () => setPhone(query.matches);
    query.addEventListener("change", follow);
    return () => query.removeEventListener("change", follow);
  }, []);
  return phone;
}

function readTab(): Tab {
  try {
    const kept = sessionStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.id === kept) ? (kept as Tab) : "study";
  } catch {
    return "study";
  }
}

export function App() {
  const session = useSession();
  // Reads start once the service takes the display's token, or lets anyone read.
  const reads = session?.reads ?? false;
  const store = useStore(reads);
  const [selected, setSelected] = useState<string | null>(() => location.hash.slice(1) || null);
  const [preview, setPreview] = useState<StudyView | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  // The engagement viewer is open, which hides the rest of the page as a source page does.
  const [viewing, setViewing] = useState(false);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [tab, setTabState] = useState<Tab>(readTab);
  // The simulator loads once its tab first shows, and again to replay a run.
  const [simulator, setSimulator] = useState<{ src: string; key: number } | null>(null);
  // A layer a figure was measured on, to show on the map; n counts each ask.
  const [focusLayer, setFocusLayer] = useState<{ id: string; n: number } | null>(null);
  const phone = usePhone();
  const tabs = useRef<HTMLDivElement>(null);

  const setTab = useCallback((next: Tab) => {
    setTabState(next);
    if (next === "sim") setSimulator((now) => now ?? { src: "/simulator/", key: 0 });
    try {
      sessionStorage.setItem(TAB_KEY, next);
    } catch {
      // Kept for the page only.
    }
  }, []);
  // The chat is a tab only on a phone. Wider, it's always beside the workspace.
  const current: Tab = tab === "chat" && !phone ? "study" : tab;
  // Off the Map tab the map is the backdrop, blurred and still, so time stops too.
  const ambient = current !== "map";
  useEffect(() => {
    if (current === "sim") setSimulator((now) => now ?? { src: "/simulator/", key: 0 });
  }, [current]);

  const studyId = selected ?? store.focus ?? (store.studies.find((s) => s.id === LEAD) ?? store.studies[0])?.id ?? null;
  const study = store.studies.find((s) => s.id === studyId) ?? null;
  const shown = useMemo(() => shownStudy(study, preview), [study, preview]);

  const clock = useMemo(() => new Simulator(), []);

  useEffect(() => {
    const end = study?.trial?.reviewOn ? dateToMs(study.trial.reviewOn) : Date.now() + FIRST_REVIEW_DAYS * 86_400_000;
    clock.setEnd(end);
  }, [clock, study?.trial?.reviewOn]);

  // Only a study with a trial has the time bar. Any other holds the map at the
  // present, so time can't be left playing or rewound out of sight.
  const trial = study?.trial ?? null;
  useEffect(() => {
    if (!trial) clock.backToNow();
  }, [clock, studyId, Boolean(trial)]);
  useEffect(() => {
    if (ambient) clock.pause();
  }, [clock, ambient]);

  useEffect(() => {
    if (!studyId || !reads) return;
    let live = true;
    const load = async () => {
      const response = await api(`/v1/studies/${studyId}/timeline`);
      if (live && response.ok) setTimeline((await response.json()) as Timeline);
    };
    void load();
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [studyId, store.studies, reads]);

  // An agent adding a layer, or the planner asking about the map, brings the map into view.
  useEffect(() => {
    if (store.mapAsk && store.mapAsk.studyId === studyId) setTab("map");
  }, [store.mapAsk?.seq]);

  const select = useCallback((id: string) => {
    setSelected(id);
    setPreview(null);
    history.replaceState(null, "", `#${id}`);
  }, []);

  const openFigure = useCallback(
    async (figureId: string) => {
      if (!studyId) return;
      // A figure measured on a map layer has no page: it opens the layer on the map.
      const figure = study?.figures.find((f) => f.id === figureId);
      const layer = figure ? spatialLayer(figure) : null;
      if (layer) {
        setFocusLayer((now) => ({ id: layer, n: (now?.n ?? 0) + 1 }));
        return setTab("map");
      }
      const response = await api(`/v1/studies/${studyId}/figures/${figureId}/trace`);
      if (!response.ok) return;
      const trace = (await response.json()) as TraceNode;
      const leaves: Opened["sources"] = [];
      const steps: Opened["steps"] = [];
      const walk = (node: TraceNode) => {
        if (node.basis.citation) leaves.push({ label: node.label, value: node.value, unit: node.unit, ...node.basis.citation });
        // In the order the formula names them, so the sources read like it.
        const names = Object.keys(node.basis.inputs ?? {});
        const at = (i: number) => node.basis.formula?.search(new RegExp(`\\b${names[i]}\\b`)) ?? i;
        const inputs = (node.inputs ?? []).map((input, i) => ({ input, at: at(i) })).sort((a, b) => a.at - b.at);
        for (const { input } of inputs) {
          if ("assumption" in input) {
            const { label, value, unit, citation, reason, owner } = input.assumption;
            // A rule with a page opens as a source. A value a planner set has none, so it shows beside the formula, with why and who set it.
            if (citation) leaves.push({ label, value, unit, ...citation });
            else if (!steps.some((s) => s.label === label)) steps.push({ label, value, unit, reason, owner });
          } else walk(input);
        }
      };
      walk(trace);
      setOpened({ title: trace.label, value: trace.value, unit: trace.unit, by: trace.entry?.actor, formula: written(trace), sources: leaves, steps });
    },
    [studyId, study],
  );

  const openCitation = useCallback((item: CheckView | FindingView) => {
    const citation = "citation" in item ? item.citation : item.rule;
    if (!citation) return;
    setOpened({ title: item.label, sources: [{ label: item.label, ...citation }], steps: [] });
  }, []);

  // A page an agent cited in the chat. It has no quote to mark, so the whole page shows.
  const openPage = useCallback(
    (contextId: string, page: number) => {
      const title = store.contexts.find((c) => c.id === contextId)?.title ?? contextId;
      setOpened({ title: `${title}, page ${page}`, sources: [{ label: title, contextId, page, quote: "" }], steps: [] });
    },
    [store.contexts],
  );

  // A file's first page, from the Files tab.
  const openFile = useCallback((context: Context) => {
    setOpened({ title: context.title, sources: [{ label: context.title, contextId: context.id, page: 1, quote: "" }], steps: [] });
  }, []);

  // An engagement need's reason and pages, with what a planner can do about it.
  const openNeed = useCallback((need: Opened) => setOpened(need), []);

  // Review: the notice's study, then the tab it's on, then what it's about. A
  // document opens in a tab of its own.
  const review = useCallback(
    (notice: Notice) => {
      if (notice.target.kind === "document") return void window.open(notice.target.url, "_blank", "noopener");
      select(notice.studyId);
      const to = tabFor(notice.target.kind, phone);
      if (to) setTab(to);
      void reveal(notice.target, notice.studyId);
    },
    [select, phone],
  );

  const closeQuickLook = useCallback(() => setOpened(null), []);

  // The Files tab shows drafts made since this tab first loaded the log, so a new
  // tab starts clean; a reload keeps them. The chat still has every document.
  const [draftsSince, setDraftsSince] = useState<number | null>(() => {
    try {
      const kept = sessionStorage.getItem("drafts.since");
      return kept === null ? null : Number(kept);
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (draftsSince !== null || store.since === null) return;
    setDraftsSince(store.since);
    try {
      sessionStorage.setItem("drafts.since", String(store.since));
    } catch {
      // Kept for the page only.
    }
  }, [store.since, draftsSince]);

  const layerCount = store.layers.filter((layer) => layer.studyId === studyId).length;
  const layerVersion = `${layerCount}`;
  // Layers agents added since the page opened, which open the Layers panel.
  const since = store.since;
  const freshLayers = since === null ? "" : store.layers.flatMap((layer) => (layer.studyId === studyId && layer.seq > since ? [layer.layerId] : [])).join(",");
  const visible = TABS.filter((t) => phone || !t.phoneOnly);
  // Arrows, Home and End move along the tabs and open the one they reach.
  const onTabKey = (event: KeyboardEvent) => {
    const next = nextTab(visible.map((t) => t.id), current, event.key);
    if (!next) return;
    event.preventDefault();
    setTab(next);
    tabs.current?.querySelector<HTMLElement>(`#tab-${next}`)?.focus();
  };

  return (
    <div class="app" data-tab={current}>
      <Rail
        studies={store.studies}
        studyId={studyId}
        session={session}
        testBuild={TEST_BUILD}
        onSelect={select}
        notices={<Notices notices={store.heard.notices} studies={store.studies} covered={opened !== null || viewing} onScreen={studyId} onReview={review} />}
      />
      <main class="workspace" aria-labelledby="study-title">
        <header class="workspace-head">
          <h1 id="study-title">{shown?.title ?? "Transit Agents"}</h1>
          <div ref={tabs} class="tabs" role="tablist" aria-label="Views" onKeyDown={onTabKey}>
            {visible.map(({ id, label, icon }) => {
              const busy = id === "files" && store.reading !== null;
              const count = id === "map" && layerCount ? layerCount : 0;
              return (
                <button
                  key={id}
                  id={`tab-${id}`}
                  type="button"
                  role="tab"
                  class={id === "chat" ? "tab phone-only" : "tab"}
                  aria-selected={current === id}
                  aria-controls={id === "chat" ? "chat" : `panel-${id}`}
                  tabIndex={current === id ? 0 : -1}
                  onClick={() => setTab(id)}
                >
                  <LineIcon name={icon} size={18} />
                  {label}
                  {count > 0 && (
                    <span class="count">
                      {count}
                      <span class="sr-only">{count === 1 ? " layer" : " layers"}</span>
                    </span>
                  )}
                  {busy && (
                    <span class="busy-dot">
                      <span class="sr-only">, an agent is reading</span>
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </header>

        <section id="panel-study" class="panel study-panel" role="tabpanel" aria-labelledby="tab-study" hidden={current !== "study"}>
          {shown && (
            <StudyPage
              study={shown}
              session={session}
              assumptions={store.assumptions}
              contexts={store.contexts}
              since={store.since}
              timeline={timeline}
              onPreview={setPreview}
              onFigure={openFigure}
              onCitation={openCitation}
              onLayer={(id) => {
                setFocusLayer((now) => ({ id, n: (now?.n ?? 0) + 1 }));
                setTab("map");
              }}
            />
          )}
        </section>

        {/* Always there: the whole app's backdrop, blurred and still behind the other
            tabs, and in front, to use, on this one. */}
        <section
          id="panel-map"
          class="map-panel"
          role="tabpanel"
          aria-labelledby="tab-map"
          data-ambient={ambient || undefined}
          aria-hidden={ambient || undefined}
          inert={ambient}
        >
          <MapView
            study={shown}
            simulator={clock}
            canCreate={canCreate(session?.me ?? null)}
            reads={reads}
            layerVersion={layerVersion}
            freshLayers={freshLayers}
            picked={selected}
            focus={focusLayer}
            ambient={ambient}
            onNeed={openNeed}
            onViewer={setViewing}
          >
            {trial && current === "map" && <TimeBar simulator={clock} timeline={timeline} trialStart={trial.startedOn} />}
          </MapView>
        </section>

        <section id="panel-files" class="panel files-panel" role="tabpanel" aria-labelledby="tab-files" hidden={current !== "files"}>
          <Files
            contexts={store.contexts}
            drafts={store.documents.filter((document) => document.studyId === studyId && draftsSince !== null && document.seq > draftsSince)}
            reading={store.reading}
            canAdd={canAdd(session?.me ?? null)}
            onOpen={openFile}
          />
        </section>

        <section id="panel-sim" class="panel sim-panel" role="tabpanel" aria-labelledby="tab-sim" hidden={current !== "sim"}>
          {simulator && (
            <>
              <div class="sim-head">
                <p>
                  <strong>Intersection Simulator 4.2</strong> · Don Mills & Eglinton, sample data
                </p>
                <a class="icon-link wide" href={simulator.src} target="_blank" rel="noopener">
                  <LineIcon name="open" size={16} />
                  New window
                </a>
              </div>
              <iframe key={simulator.key} src={simulator.src} title="Intersection simulator" />
            </>
          )}
        </section>
      </main>
      <Chat
        store={store}
        studyId={studyId}
        canPost={canPost(session?.me ?? null)}
        ping={{ to: session?.config ? (session.config.executive ?? null) : undefined, can: canDecide(session?.me ?? null) }}
        onPage={openPage}
        onSimulator={() => {
          setSimulator((now) => ({ src: "/simulator/#replay", key: (now?.key ?? 0) + 1 }));
          setTab("sim");
        }}
      />
      <QuickLook opened={opened} contexts={store.contexts} onClose={closeQuickLook} />
      <Intro />
    </div>
  );
}
