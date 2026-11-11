// The Skills page's cards, from /docs/skills.json, which scripts/build-docs-data.ts
// writes from each SKILL.md, its scripts and the eval cases.

const list = document.getElementById("skills");
const status = document.getElementById("status");

function item(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.append(node);
  return node;
}

function card(skill) {
  const li = item(list, "li", "skill pane");
  item(li, "h2", "", skill.name);
  item(li, "p", "", skill.summary);
  const facts = item(li, "ul", "facts");
  if (skill.scripts) {
    const tools = skill.tools === null ? "" : ` · ${skill.tools} ${skill.tools === 1 ? "tool" : "tools"}`;
    item(facts, "li", "badge", `Scripts${tools}`);
  }
  const { dev, test, future } = skill.cases;
  const splits = [`${dev} dev`, `${test} test`, ...(future ? [`${future} future`] : [])].join(" · ");
  item(facts, "li", "", `Evals ${splits}`);
}

try {
  const response = await fetch("/docs/skills.json");
  if (!response.ok) throw new Error(String(response.status));
  const { skills } = await response.json();
  for (const skill of skills) card(skill);
} catch {
  status.textContent = "The skills couldn't be loaded. Reload to try again.";
} finally {
  list.removeAttribute("aria-busy");
}
