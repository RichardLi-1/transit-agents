// What the chat offers to ask in each study. Each stays until it's asked there, so
// a planner can take them one after another; four at most, so a first look isn't
// a wall of text.
// On the local demo, computer use runs from the chat (npm run dev opens the simulator
// on this machine), so it's offered there in place of the stakeholder question.
export const SIMULATOR = "Retime the Don Mills & Eglinton signal in the simulator";
const local = typeof location !== "undefined" && /^(127\.0\.0\.1|localhost)$/.test(location.hostname);
export const SUGGESTIONS = [
  "What would it cost to extend the Ontario Line up Don Mills to Sheppard?",
  "Compare the two alignment options",
  local ? SIMULATOR : "Who needs to hear about this?",
  "Make a TPAP brief as a PDF",
];

// What each study has been asked, by study.
export type Asked = Readonly<Record<string, readonly string[]>>;

// The suggestions not yet asked in a study.
export const unasked = (asked: Asked, studyId: string) => SUGGESTIONS.filter((s) => !asked[studyId]?.includes(s));

// With one more question asked in a study. Only a suggestion's words are kept.
export const withAsked = (asked: Asked, studyId: string, words: string): Asked =>
  SUGGESTIONS.includes(words) && !asked[studyId]?.includes(words) ? { ...asked, [studyId]: [...(asked[studyId] ?? []), words] } : asked;
