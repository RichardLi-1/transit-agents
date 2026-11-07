import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluate, FormulaError, variables } from "./formula.ts";

describe("evaluate", () => {
  it("computes the published Lawrence productivity", () => {
    assert.equal(evaluate("riders / hours", { riders: 1680, hours: 25 }), 67.2);
  });

  it("respects precedence and parentheses", () => {
    assert.equal(evaluate("2 + 3 * 4", {}), 14);
    assert.equal(evaluate("(2 + 3) * 4", {}), 20);
    assert.equal(evaluate("-(2 + 3) * 2", {}), -10);
    assert.equal(evaluate("10 - 3 - 2", {}), 5);
  });

  it("supports min and max", () => {
    assert.equal(evaluate("min(a, 5) + max(1, 2, 3)", { a: 4 }), 7);
  });

  it("rejects unknown names, division by zero and trailing input", () => {
    assert.throws(() => evaluate("a + 1", {}), FormulaError);
    assert.throws(() => evaluate("1 / 0", {}), FormulaError);
    assert.throws(() => evaluate("1 2", {}), FormulaError);
    assert.throws(() => evaluate("(1", {}), FormulaError);
    assert.throws(() => evaluate("", {}), FormulaError);
  });

  it("refuses anything that is not arithmetic", () => {
    for (const attack of ["process.exit()", "require('fs')", "a; b", "constructor(1)", "`x`", "a[0]", "1 ** 2"]) {
      assert.throws(() => evaluate(attack, { a: 1, b: 1, process: 1, constructor: 1 }), FormulaError, attack);
    }
  });

  it("does not read names from the object prototype", () => {
    assert.throws(() => evaluate("toString + 1", {}), FormulaError);
  });
});

describe("variables", () => {
  it("lists each name once", () => {
    assert.deepEqual(variables("a * b + max(a, c)").sort(), ["a", "b", "c"]);
  });
});
