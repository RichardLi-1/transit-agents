import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keepPins, MOST, pinLine, readPins, togglePin } from "./pins.ts";

const store = () => {
  const kept = new Map<string, string>();
  return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
};

describe("pins", () => {
  it("pins and unpins a message, by study", () => {
    let pins = togglePin({}, "a", 5);
    pins = togglePin(pins, "a", 9);
    pins = togglePin(pins, "b", 2);
    assert.deepEqual(pins, { a: [5, 9], b: [2] });
    pins = togglePin(pins, "a", 5);
    pins = togglePin(pins, "b", 2);
    assert.deepEqual(pins, { a: [9] });
  });

  it("keeps the newest few, letting go of the oldest", () => {
    let pins: Record<string, number[]> = {};
    for (let seq = 1; seq <= MOST + 3; seq++) pins = togglePin(pins, "a", seq);
    assert.equal(pins.a?.length, MOST);
    assert.equal(pins.a?.[0], 4);
  });

  it("survives a reload, and ignores what isn't pins", () => {
    const storage = store();
    keepPins({ a: [3, 7] }, storage);
    assert.deepEqual(readPins(storage), { a: [3, 7] });
    storage.setItem("chat.pins", '{"a": [1, "x", 2.5, 4], "b": "no"}');
    assert.deepEqual(readPins(storage), { a: [1, 4] });
    storage.setItem("chat.pins", "not json");
    assert.deepEqual(readPins(storage), {});
    assert.deepEqual(readPins(null), {});
  });

  it("shows a message's first line, plain and cut short", () => {
    assert.equal(pinLine("\nReady for planners: about **$3,678 M**.\n\nNot known yet:"), "Ready for planners: about $3,678 M.");
    assert.equal(pinLine("x".repeat(100), 10), `${"x".repeat(9)}…`);
  });
});
