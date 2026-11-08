// What the chat offers to ask in each study. Each stays until it's asked there, so
// a planner can take them one after another; four at most, so a first look isn't
// a wall of text.
export const SUGGESTIONS = [
  "What would it cost to extend the Ontario Line up Don Mills to Sheppard?",
  "Compare the two alignment options",
  "Who needs to hear about this?",
  "Make a TPAP brief as a PDF",
];

// What each study has been asked, by study.
export type Asked = Readonly<Record<string, readonly string[]>>;

// The suggestions not yet asked in a study.
export const unasked = (asked: Asked, studyId: string) => SUGGESTIONS.filter((s) => !asked[studyId]?.includes(s));

// With one more question asked in a study. Only a suggestion's words are kept.
export const withAsked = (asked: Asked, studyId: string, words: string): Asked =>
  SUGGESTIONS.includes(words) && !asked[studyId]?.includes(words) ? { ...asked, [studyId]: [...(asked[studyId] ?? []), words] } : asked;
