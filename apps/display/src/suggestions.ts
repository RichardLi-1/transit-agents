// What the chat offers to ask in each study. Each stays until it's asked there, so
// a planner can take them one after another; four at most, so a first look isn't
// a wall of text.
// On the local demo, computer use runs from the chat (npm run dev opens the simulator
// on this machine), so it's offered there in place of the stakeholder question.
export const SIMULATOR = "Retime the Don Mills & Eglinton signal in the simulator";
export const local = typeof location !== "undefined" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
// An ask for the simulator: on the local demo Gemini drives it; elsewhere it opens for
// the viewer to try, as no server here has a screen for Gemini to drive it on.
export const wantsSimulator = (text: string) => /\b(simulator|signal timing|retime|computer use)\b/i.test(text);
export const SUGGESTIONS = [
  "What would it cost to extend the Ontario Line up Don Mills to Sheppard?",
  "Compare the two alignment options",
  SIMULATOR,
  "Make a TPAP brief as a PDF",
];

// More to ask, behind More: one or two for each skill, each a question from that
// skill's eval cases put in plainer words, so each is one the agents are tested on.
export const MORE = [
  "What benefit-cost ratio did the Ontario Line's Initial Business Case report?",
  "At the Ontario Line's cost per km, what would a 6 km extension cost?",
  "What optimism bias does Metrolinx set for capital costs at the Initial Business Case stage?",
  "Which chapters should a Metrolinx business case have?",
  "How many people worked within 800 m of the Line 4 Sheppard stations in 2021?",
  "How many people live within 500 m of the 25 Don Mills route?",
  "How does the share commuting by transit near the 25 Don Mills stops compare with the City's?",
  "Which Neighbourhood Improvement Areas are within 400 m of the 100 Flemingdon Park stops?",
  "How many pedestrians were killed or seriously injured within 50 m of the 25 Don Mills route from 2016 to 2025?",
  "How many of the 25 Don Mills stops have no bike share station within 400 m?",
  "Which Line 2 stations have a platform that isn't wheelchair accessible?",
  "How many trips does the 52 Lawrence West run on a weekday?",
  "What's the TTC's peak minimum for a local bus, in boardings per service hour?",
  "What makes a TTC service change major rather than minor?",
  "What was customers' main concern about the Lawrence–Sunnybrook change?",
  "What is a Class 5 estimate?",
];

const ALL = [...SUGGESTIONS, ...MORE];

// What each study has been asked, by study.
export type Asked = Readonly<Record<string, readonly string[]>>;

// The suggestions not yet asked in a study, of the first four or of More's.
export const unasked = (asked: Asked, studyId: string, from: readonly string[] = SUGGESTIONS) =>
  from.filter((s) => !asked[studyId]?.includes(s));

// With one more question asked in a study. Only a suggestion's words are kept.
export const withAsked = (asked: Asked, studyId: string, words: string): Asked =>
  ALL.includes(words) && !asked[studyId]?.includes(words) ? { ...asked, [studyId]: [...(asked[studyId] ?? []), words] } : asked;

// The first visit's path, in order: each step's question, and what to look at in its
// answer. The chat offers the first as "Try this first", then, after each answer, the
// next as "Try next" with the tip, until each is asked in the study or the tips are hidden.
export const GUIDE: readonly { ask: string; look: string | null }[] = [
  { ask: SUGGESTIONS[0] as string, look: "Open a cited page in the answer to see where its figure came from." },
  { ask: "Compare the two alignment options", look: "Picking one is an executive's call, so the agents hand it over instead of choosing." },
  { ask: "Make a TPAP brief as a PDF", look: null },
];

// The guide in a study: the next step to try, or null once each is asked, and the tip
// for the last one asked, or null before the first.
export function guideStep(asked: Asked, studyId: string): { next: string | null; look: string | null } {
  const done = GUIDE.filter((step) => asked[studyId]?.includes(step.ask));
  return { next: GUIDE.find((step) => !done.includes(step))?.ask ?? null, look: done.at(-1)?.look ?? null };
}

// Whether the viewer hid the tips, in this browser, for good.
const HIDDEN = "guide.hidden";
export function guideHidden(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(HIDDEN) === "1";
  } catch {
    return false;
  }
}
export function hideGuide(storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    storage?.setItem(HIDDEN, "1");
  } catch {
    // Hidden for this page only.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
