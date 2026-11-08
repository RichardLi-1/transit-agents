import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CheckView, FindingView, StudyView, Timeline } from "@transit-agents/contracts";
import { Account } from "./components/Account.tsx";
import { Chat } from "./components/Chat.tsx";
import { MapView, type Credit } from "./components/MapView.tsx";
import { Notices } from "./components/Notices.tsx";
import { QuickLook, type Opened } from "./components/QuickLook.tsx";
import { Shelf } from "./components/Shelf.tsx";
import { StudyCard } from "./components/StudyCard.tsx";
import { Thread } from "./components/Thread.tsx";
import { TimeBar } from "./components/TimeBar.tsx";
import { api } from "./api.ts";
import { isTestBuild } from "./host.ts";
import type { Notice } from "./notify.ts";
import { shownStudy } from "./preview.ts";
import { reveal } from "./reveal.ts";
import { canAdd, canCreate, canPost, useSession } from "./session.ts";
import { Simulator } from "./simulator.ts";
import { useStore } from "./store.ts";
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
      const input = node.inputs[i];
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
  const [from, setFrom] = useState<Element | null>(null);
  const [credit, setCredit] = useState<Credit | null>(null);

  const studyId = selected ?? store.focus ?? (store.studies.find((s) => s.id === LEAD) ?? store.studies[0])?.id ?? null;
  const study = store.studies.find((s) => s.id === studyId) ?? null;
  const shown = useMemo(() => shownStudy(study, preview), [study, preview]);

  const simulator = useMemo(() => new Simulator(), []);

  useEffect(() => {
    const end = study?.trial?.reviewOn ? dateToMs(study.trial.reviewOn) : Date.now() + FIRST_REVIEW_DAYS * 86_400_000;
    simulator.setEnd(end);
  }, [simulator, study?.trial?.reviewOn]);

  // Only a study with a trial has the time bar. Any other holds the map at the
  // present, so time can't be left playing or rewound out of sight.
  const trial = study?.trial ?? null;
  useEffect(() => {
    if (!trial) simulator.backToNow();
  }, [simulator, studyId, Boolean(trial)]);

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

  const select = useCallback((id: string) => {
    setSelected(id);
    setPreview(null);
    history.replaceState(null, "", `#${id}`);
  }, []);

  const openFigure = useCallback(
    async (figureId: string, element: Element) => {
      if (!studyId) return;
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
        const inputs = node.inputs.map((input, i) => ({ input, at: at(i) })).sort((a, b) => a.at - b.at);
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
      setFrom(element);
      setOpened({ title: trace.label, value: trace.value, unit: trace.unit, by: trace.entry?.actor, formula: written(trace), sources: leaves, steps });
    },
    [studyId],
  );

  const openCitation = useCallback((item: CheckView | FindingView, element: Element) => {
    const citation = "citation" in item ? item.citation : item.rule;
    if (!citation) return;
    setFrom(element);
    setOpened({ title: item.label, sources: [{ label: item.label, ...citation }], steps: [] });
  }, []);

  // A page an agent cited in the chat. It has no quote to mark, so the whole page shows.
  const openPage = useCallback(
    (contextId: string, page: number, element: Element) => {
      const title = store.contexts.find((c) => c.id === contextId)?.title ?? contextId;
      setFrom(element);
      setOpened({ title: `${title}, page ${page}`, sources: [{ label: title, contextId, page, quote: "" }], steps: [] });
    },
    [store.contexts],
  );

  // An engagement need's reason and pages, with what a planner can do about it.
  const openNeed = useCallback((need: Opened, element: Element) => {
    setFrom(element);
    setOpened(need);
  }, []);

  // Review: the notice's study, then what it's about.
  const review = useCallback(
    (notice: Notice) => {
      select(notice.studyId);
      void reveal(notice.target, notice.studyId);
    },
    [select],
  );

  const closeQuickLook = useCallback(() => {
    setOpened(null);
    setFrom(null);
  }, []);

  const target = opened?.sources[0]?.contextId;
  const targetFolder = store.contexts.find((c) => c.id === target)?.folder;

  return (
    <>
      <header>
        <h1 class="sr-only">Transit Agents</h1>
        {TEST_BUILD && <p class="tag build">Test build</p>}
        <Shelf
          contexts={store.contexts}
          reading={store.reading}
          highlight={targetFolder ?? null}
          canAdd={canAdd(session?.me ?? null)}
        />
        <Account session={session} />
        <Notices notices={store.heard.notices} studies={store.studies} covered={opened !== null || viewing} onReview={review} />
      </header>
      <section aria-label="Map">
        <MapView study={shown} simulator={simulator} canCreate={canCreate(session?.me ?? null)} picked={selected} onCredit={setCredit} onNeed={openNeed} onViewer={setViewing} />
      </section>
      <main class="stage">
        {shown && (
          <StudyCard
            study={shown}
            session={session}
            studies={store.studies}
            assumptions={store.assumptions}
            since={store.since}
            timeline={timeline}
            onSelect={select}
            onPreview={setPreview}
            onFigure={openFigure}
            onCitation={openCitation}
          />
        )}
        {trial && <TimeBar simulator={simulator} timeline={timeline} trialStart={trial.startedOn} />}
      </main>
      <Chat store={store} studyId={studyId} canPost={canPost(session?.me ?? null)} onPage={openPage} />
      {credit && (
        // The page's footer, so the credit sits in a landmark of its own.
        <footer>
          <a class="credit" href={credit.url} target="_blank" rel="noopener noreferrer">
            {credit.text}
          </a>
        </footer>
      )}
      <QuickLook opened={opened} contexts={store.contexts} onClose={closeQuickLook} />
      <Thread from={from} folder={targetFolder ?? null} />
    </>
  );
}
