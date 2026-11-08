import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { CheckView, FindingView, StudyView, Timeline } from "@transit-agents/contracts";
import { Account } from "./components/Account.tsx";
import { Chat } from "./components/Chat.tsx";
import { MapView } from "./components/MapView.tsx";
import { QuickLook, type Opened } from "./components/QuickLook.tsx";
import { Shelf } from "./components/Shelf.tsx";
import { StudyCard } from "./components/StudyCard.tsx";
import { Thread } from "./components/Thread.tsx";
import { TimeBar } from "./components/TimeBar.tsx";
import { api } from "./api.ts";
import { isTestBuild } from "./host.ts";
import { canAdd, canPost, useSession } from "./session.ts";
import { Simulator } from "./simulator.ts";
import { useStore } from "./store.ts";
import { dateToMs } from "./time.ts";

type TraceNode = {
  id: string;
  label: string;
  value: number;
  unit: string;
  basis: { kind: string; citation?: { contextId: string; page: number; quote: string }; formula?: string };
  inputs: (TraceNode | { assumption: { key: string; label: string; value: number; citation?: { contextId: string; page: number; quote: string } } })[];
};

const FIRST_REVIEW_DAYS = 365;
const TEST_BUILD = isTestBuild(location.hostname);

export function App() {
  const session = useSession();
  // Reads start once the service takes the display's token, or lets anyone read.
  const reads = session?.reads ?? false;
  const store = useStore(reads);
  const [selected, setSelected] = useState<string | null>(() => location.hash.slice(1) || null);
  const [preview, setPreview] = useState<StudyView | null>(null);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [from, setFrom] = useState<Element | null>(null);

  const studyId = selected ?? store.focus ?? store.studies[0]?.id ?? null;
  const study = store.studies.find((s) => s.id === studyId) ?? null;
  const shown = preview?.id === study?.id ? preview : study;

  const simulator = useMemo(() => new Simulator(), []);

  useEffect(() => {
    const end = study?.trial?.reviewOn ? dateToMs(study.trial.reviewOn) : Date.now() + FIRST_REVIEW_DAYS * 86_400_000;
    simulator.setEnd(end);
  }, [simulator, study?.trial?.reviewOn]);

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
        for (const input of node.inputs) {
          if ("assumption" in input) {
            steps.push({ label: input.assumption.label, value: input.assumption.value });
            if (input.assumption.citation) leaves.push({ label: input.assumption.label, value: input.assumption.value, unit: "", ...input.assumption.citation });
          } else walk(input);
        }
      };
      walk(trace);
      setFrom(element);
      setOpened({ title: trace.label, value: trace.value, unit: trace.unit, formula: trace.basis.formula, sources: leaves, steps });
    },
    [studyId],
  );

  const openCitation = useCallback((item: CheckView | FindingView, element: Element) => {
    const citation = "citation" in item ? item.citation : item.rule;
    if (!citation) return;
    setFrom(element);
    setOpened({ title: item.label, sources: [{ label: item.label, ...citation }], steps: [] });
  }, []);

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
      </header>
      <section aria-label="Map">
        <MapView study={shown} simulator={simulator} />
        <div class="fade" aria-hidden="true" />
      </section>
      <main class="stage">
        {shown && (
          <StudyCard
            study={shown}
            studies={store.studies}
            timeline={timeline}
            onSelect={select}
            onPreview={setPreview}
            onFigure={openFigure}
            onCitation={openCitation}
          />
        )}
        <TimeBar simulator={simulator} timeline={timeline} trialStart={study?.trial?.startedOn ?? null} visible={Boolean(study)} />
      </main>
      <Chat store={store} studyId={studyId} canPost={canPost(session?.me ?? null)} />
      <QuickLook opened={opened} onClose={closeQuickLook} />
      <Thread from={from} folder={targetFolder ?? null} />
    </>
  );
}
