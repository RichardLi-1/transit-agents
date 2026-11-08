// Who recorded a figure, or set a value, in plain words. The log names every
// actor as role:name. The replay is a script: no model did its work.
export function recordedBy(actor: string): string {
  if (actor === "agent:replay") return "Recorded by the scripted replay";
  const [role, name = ""] = actor.split(":");
  if (role === "planner") return `Set by planner ${name}`.trim();
  return `Recorded by ${role} ${name}`.trim();
}
