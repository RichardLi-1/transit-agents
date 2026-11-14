// The model the agents answer this viewer's chat on, as they choose in Settings from the
// service's choices (MODEL_CHOICES). Kept in this browser, as the appearance is. Until
// the viewer chooses, messages ask for none, and the agents use their own default, the
// first choice on the public demo.
import type { ModelChoices } from "@transit-agents/contracts";

const KEY = "agent.model";

// The model to ask for: the viewer's choice while the service still offers it, else none.
export function askedModel(models: ModelChoices | null | undefined, storage: Pick<Storage, "getItem"> | null = safeStorage()): string | undefined {
  if (!models) return undefined;
  try {
    const kept = storage?.getItem(KEY);
    return kept && models.choices.includes(kept) ? kept : undefined;
  } catch {
    return undefined;
  }
}

// The model Settings shows as chosen.
export const shownModel = (models: ModelChoices, storage?: Pick<Storage, "getItem"> | null) => askedModel(models, storage) ?? models.default;

export function chooseModel(model: string, storage: Pick<Storage, "setItem"> | null = safeStorage()) {
  try {
    storage?.setItem(KEY, model);
  } catch {
    // Storage blocked: the choice holds for this page only.
  }
}

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

// A model's name for people: gemini-3.6-flash as Gemini 3.6 Flash, and an open model
// such as qwen3.5:9b as Qwen3.5 9B, on-prem.
export function modelLabel(model: string): string {
  if (model.startsWith("gemini-")) return model.split("-").map(capital).join(" ").replace(/Flash Lite$/, "Flash-Lite");
  const [name = model, size] = model.split(":");
  return `${capital(name)}${size ? ` ${size.toUpperCase()}` : ""}, on-prem`;
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
