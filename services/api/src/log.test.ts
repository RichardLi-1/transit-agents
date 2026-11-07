import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { canonical, Log } from "./log.ts";

describe("Log", () => {
  let log: Log;
  beforeEach(() => {
    log = new Log(":memory:");
    log.append({ actor: "agent:a", type: "figure.recorded", studyId: "s", data: { value: 67 } });
    log.append({ actor: "planner:p", type: "decision.recorded", studyId: "s", data: { outcome: "adopt" } });
    log.append({ actor: "planner:p", type: "assumption.set", data: { key: "k", value: 11 } });
  });

  it("chains each entry to the one before", () => {
    const [first, second] = log.since(0);
    assert.equal(second?.prevHash, first?.hash);
    assert.deepEqual(log.verify(), { ok: true, entries: 3, head: log.head().hash });
  });

  it("refuses updates and deletes", () => {
    assert.throws(() => log.db.exec("UPDATE log SET actor = 'x' WHERE seq = 1"), /append-only/);
    assert.throws(() => log.db.exec("DELETE FROM log WHERE seq = 1"), /append-only/);
  });

  it("detects an edit made after the triggers are removed", () => {
    log.db.exec("DROP TRIGGER log_no_update");
    log.db.exec(`UPDATE log SET data = '{"outcome":"reject"}' WHERE seq = 2`);
    assert.deepEqual(log.verify(), { ok: false, brokenAt: 2, reason: "Entry does not match its hash" });
  });

  it("detects a deleted entry", () => {
    log.db.exec("DROP TRIGGER log_no_delete");
    log.db.exec("DELETE FROM log WHERE seq = 2");
    assert.deepEqual(log.verify(), { ok: false, brokenAt: 2, reason: "An entry is missing" });
  });

  it("an insider who rewrites the whole chain changes the head, so a past head exposes them", () => {
    const witnessed = log.head().hash;
    log.db.exec("DROP TRIGGER log_no_delete");
    log.db.exec("DELETE FROM log");
    const rebuilt = new Log(":memory:");
    rebuilt.append({ actor: "agent:a", type: "figure.recorded", studyId: "s", data: { value: 99 } });
    assert.notEqual(rebuilt.head().hash, witnessed);
  });

  it("tells subscribers about each new entry", () => {
    const seen: number[] = [];
    const stop = log.subscribe((e) => seen.push(e.seq));
    log.append({ actor: "a", type: "t", data: {} });
    stop();
    log.append({ actor: "a", type: "t", data: {} });
    assert.deepEqual(seen, [4]);
  });

  it("reads forward from a position", () => {
    assert.deepEqual(log.since(1).map((e) => e.seq), [2, 3]);
    assert.deepEqual(log.since(1, 1).map((e) => e.seq), [2]);
  });
});

describe("canonical", () => {
  it("ignores key order", () => {
    assert.equal(canonical({ b: 1, a: { d: 2, c: 3 } }), canonical({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("drops undefined and keeps null", () => {
    assert.equal(canonical({ a: undefined, b: null }), '{"b":null}');
  });
});
