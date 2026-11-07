// A small arithmetic language for derived figures. Formulas arrive from agents,
// so they are parsed, never evaluated as code.
//
//   riders / hours
//   published * ridership_factor / hours_factor
//   min(a, b) - 1

type Node =
  | { kind: "number"; value: number }
  | { kind: "name"; name: string }
  | { kind: "negate"; value: Node }
  | { kind: "binary"; op: "+" | "-" | "*" | "/"; left: Node; right: Node }
  | { kind: "call"; name: "min" | "max"; args: Node[] };

export class FormulaError extends Error {
  override name = "FormulaError";
}

const TOKEN = /\s*(\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/(),])/y;
const MAX_LENGTH = 500;

function tokenize(source: string): string[] {
  if (source.length > MAX_LENGTH) throw new FormulaError("Formula is too long");
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.length) {
    if (source.slice(TOKEN.lastIndex).trim() === "") break;
    const start = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (!match) throw new FormulaError(`Unexpected input at position ${start}`);
    tokens.push(match[1] as string);
  }
  return tokens;
}

export function parse(source: string): Node {
  const tokens = tokenize(source);
  let at = 0;
  const peek = () => tokens[at];
  const next = () => tokens[at++];
  const expect = (token: string) => {
    if (next() !== token) throw new FormulaError(`Expected "${token}"`);
  };

  function sum(): Node {
    let left = product();
    while (peek() === "+" || peek() === "-") {
      const op = next() as "+" | "-";
      left = { kind: "binary", op, left, right: product() };
    }
    return left;
  }

  function product(): Node {
    let left = unary();
    while (peek() === "*" || peek() === "/") {
      const op = next() as "*" | "/";
      left = { kind: "binary", op, left, right: unary() };
    }
    return left;
  }

  function unary(): Node {
    if (peek() === "-") {
      next();
      return { kind: "negate", value: unary() };
    }
    return primary();
  }

  function primary(): Node {
    const token = next();
    if (token === undefined) throw new FormulaError("Formula ended early");
    if (token === "(") {
      const inner = sum();
      expect(")");
      return inner;
    }
    if (/^\d/.test(token)) return { kind: "number", value: Number(token) };
    if (/^[A-Za-z_]/.test(token)) {
      if (peek() !== "(") return { kind: "name", name: token };
      if (token !== "min" && token !== "max") throw new FormulaError(`Unknown function "${token}"`);
      next();
      const args = [sum()];
      while (peek() === ",") {
        next();
        args.push(sum());
      }
      expect(")");
      return { kind: "call", name: token, args };
    }
    throw new FormulaError(`Unexpected "${token}"`);
  }

  const tree = sum();
  if (at !== tokens.length) throw new FormulaError(`Unexpected "${peek()}"`);
  return tree;
}

export function variables(source: string): string[] {
  const found = new Set<string>();
  const walk = (node: Node) => {
    if (node.kind === "name") found.add(node.name);
    else if (node.kind === "negate") walk(node.value);
    else if (node.kind === "binary") {
      walk(node.left);
      walk(node.right);
    } else if (node.kind === "call") node.args.forEach(walk);
  };
  walk(parse(source));
  return [...found];
}

export function evaluate(source: string, scope: Record<string, number>): number {
  const run = (node: Node): number => {
    switch (node.kind) {
      case "number":
        return node.value;
      case "name": {
        if (!Object.hasOwn(scope, node.name)) throw new FormulaError(`Unknown name "${node.name}"`);
        return scope[node.name] as number;
      }
      case "negate":
        return -run(node.value);
      case "call":
        return Math[node.name](...node.args.map(run));
      case "binary": {
        const left = run(node.left);
        const right = run(node.right);
        if (node.op === "+") return left + right;
        if (node.op === "-") return left - right;
        if (node.op === "*") return left * right;
        if (right === 0) throw new FormulaError("Division by zero");
        return left / right;
      }
    }
  };
  return run(parse(source));
}
