import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import { canonical, EVERYONE, Log, REDACTED, visible } from "./log.ts";

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

  it("refuses updates and deletes, of entries and of content", () => {
    assert.throws(() => log.db.exec("UPDATE log SET actor = 'x' WHERE seq = 1"), /append-only/);
    assert.throws(() => log.db.exec("DELETE FROM log WHERE seq = 1"), /append-only/);
    assert.throws(() => log.db.exec(`UPDATE payloads SET json = '{}'`), /removed, not changed/);
  });

  it("detects changed content, even after the triggers are removed", () => {
    log.db.exec("DROP TRIGGER payloads_no_update");
    const { payloadHash } = log.get(2) as { payloadHash: string };
    log.db.exec(`UPDATE payloads SET json = '{"outcome":"reject"}' WHERE hash = '${payloadHash}'`);
    assert.deepEqual(log.verify(), { ok: false, brokenAt: 2, reason: "Content does not match its hash" });
  });

  it("detects a changed entry", () => {
    log.db.exec("DROP TRIGGER log_no_update");
    log.db.exec("UPDATE log SET actor = 'planner:someone-else' WHERE seq = 2");
    assert.deepEqual(log.verify(), { ok: false, brokenAt: 2, reason: "Entry does not match its hash" });
  });

  it("detects a deleted entry", () => {
    log.db.exec("DROP TRIGGER log_no_delete");
    log.db.exec("DELETE FROM log WHERE seq = 2");
    assert.deepEqual(log.verify(), { ok: false, brokenAt: 2, reason: "An entry is missing" });
  });

  it("removes content and still verifies, keeping the entry in place", () => {
    assert.equal(log.removePayload(2), true);
    assert.deepEqual(log.get(2)?.data, REDACTED);
    assert.equal(log.get(2)?.type, "decision.recorded");
    assert.equal(log.verify().ok, true);
  });

  it("keeps identical payloads apart, so removing one keeps the other", () => {
    log.append({ actor: "a", type: "t", data: { same: true } });
    log.append({ actor: "a", type: "t", data: { same: true } });
    log.removePayload(4);
    assert.deepEqual(log.get(5)?.data, { same: true });
  });

  it("an insider who rewrites the whole chain changes the head, so a stored head exposes them", () => {
    const witnessed = log.head().hash;
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

describe("audiences", () => {
  const A = `guest:${"a".repeat(22)}`;
  const B = `guest:${"b".repeat(22)}`;
  const at = () => new Date("2026-11-08T12:00:00.000Z");
  // Hashes made before entries had an audience, which must never change.
  const OLD = [
    { seq: 1, actor: "agent:a", type: "figure.recorded", studyId: "s", json: '{"value":67}', payloadHash: "e751388c5e4403202468b6bd51903654d19239a69150646a76ffd47df3530be3", hash: "0dd89934efa6dbf46bb3309c55a31a3c58c65dff6202651f3966c03bf1faa9be" },
    { seq: 2, actor: "planner:p", type: "assumption.set", studyId: null, json: '{"key":"k","value":11}', payloadHash: "d028876b95086ed2fa4f7aeabd95eca4b18db7dd4563c20b8a1ca5155ebd422c", hash: "a6e22038d785634e2f151ed074b80527ba4f25ded4f8c48f5581a2dcc800e745" },
  ];
  const seqs = (entries: { seq: number }[]) => entries.map((e) => e.seq);

  it("hashes an entry with no audience exactly as before", () => {
    const log = new Log(":memory:", at);
    const first = log.append({ actor: "agent:a", type: "figure.recorded", studyId: "s", data: { value: 67 } });
    const second = log.append({ actor: "planner:p", type: "assumption.set", data: { key: "k", value: 11 }, audience: null });
    assert.deepEqual([first.hash, second.hash], OLD.map((e) => e.hash));
    assert.equal(first.audience, null);
  });

  it("gives a log made before audiences the column and its index, and it still verifies", () => {
    const dir = mkdtempSync(join(tmpdir(), "transit-log-"));
    const path = join(dir, "log.db");
    try {
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE log (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, study_id TEXT,
          payload_hash TEXT NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE);
        CREATE INDEX log_study ON log (study_id);
        CREATE TABLE payloads (hash TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TRIGGER log_no_update BEFORE UPDATE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
        CREATE TRIGGER log_no_delete BEFORE DELETE ON log BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
      `);
      let prev = "0".repeat(64);
      for (const e of OLD) {
        old.prepare("INSERT INTO payloads VALUES (?, ?)").run(e.payloadHash, e.json);
        old.prepare("INSERT INTO log VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(e.seq, at().toISOString(), e.actor, e.type, e.studyId, e.payloadHash, prev, e.hash);
        prev = e.hash;
      }
      old.close();

      const log = new Log(path, at);
      const columns = log.db.prepare("PRAGMA table_info(log)").all() as { name: string }[];
      assert.ok(columns.some((c) => c.name === "audience"));
      const indexes = log.db.prepare("PRAGMA index_list(log)").all() as { name: string }[];
      assert.ok(indexes.some((i) => i.name === "log_audience"));
      assert.deepEqual(log.verify(), { ok: true, entries: 2, head: OLD[1]?.hash });
      assert.deepEqual(log.since(0).map((e) => e.audience), [null, null]);

      log.append({ actor: "guest:x", type: "activity", studyId: "s", data: { kind: "message", text: "hi" }, audience: A });
      log.append({ actor: "agent:lead", type: "figure.recorded", studyId: "s", data: { value: 1 }, audience: B });
      log.append({ actor: "planner:p", type: "assumption.set", data: { key: "k", value: 12 } });
      assert.deepEqual(log.verify(), { ok: true, entries: 5, head: log.head().hash });
      log.close();

      const reopened = new Log(path, at);
      assert.equal(reopened.verify().ok, true);
      assert.equal(reopened.get(1)?.hash, OLD[0]?.hash);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a private entry whose audience is changed or cleared, and a shared one given an audience", () => {
    const log = new Log(":memory:");
    log.append({ actor: "planner:p", type: "assumption.set", data: { key: "k", value: 11 } });
    log.append({ actor: "guest:a", type: "activity", studyId: "s", data: { kind: "message", text: "mine" }, audience: A });
    log.append({ actor: "planner:p", type: "assumption.set", data: { key: "k", value: 12 } });
    assert.equal(log.verify().ok, true);
    log.db.exec("DROP TRIGGER log_no_update");
    const broken = { ok: false, brokenAt: 2, reason: "Entry does not match its hash" };
    log.db.prepare("UPDATE log SET audience = ? WHERE seq = 2").run(B);
    assert.deepEqual(log.verify(), broken);
    log.db.exec("UPDATE log SET audience = NULL WHERE seq = 2");
    assert.deepEqual(log.verify(), broken);
    log.db.prepare("UPDATE log SET audience = ? WHERE seq = 2").run(A);
    assert.equal(log.verify().ok, true);
    log.db.prepare("UPDATE log SET audience = ? WHERE seq = 3").run(A);
    assert.deepEqual(log.verify(), { ok: false, brokenAt: 3, reason: "Entry does not match its hash" });
  });

  describe("reads", () => {
    let log: Log;
    beforeEach(() => {
      log = new Log(":memory:");
      log.append({ actor: "planner:p", type: "t", data: { n: 1 } });
      log.append({ actor: "guest:a", type: "t", data: { n: 2 }, audience: A });
      log.append({ actor: "guest:b", type: "t", data: { n: 3 }, audience: B });
      log.append({ actor: "planner:p", type: "t", data: { n: 4 } });
      log.append({ actor: "agent:lead", type: "t", data: { n: 5 }, audience: A });
    });

    it("show the shared record unless asked for more", () => {
      assert.deepEqual(seqs(log.since(0)), [1, 4]);
      assert.deepEqual(seqs(log.since(0, 1000, A)), [1, 2, 4, 5]);
      assert.deepEqual(seqs(log.since(0, 1000, B)), [1, 3, 4]);
      assert.deepEqual(seqs(log.since(0, 1000, EVERYONE)), [1, 2, 3, 4, 5]);
      assert.equal(log.get(2), undefined);
      assert.equal(log.get(2, B), undefined);
      assert.equal(log.get(2, A)?.audience, A);
      assert.equal(log.get(2, EVERYONE)?.seq, 2);
      assert.equal(log.get(4)?.audience, null);
    });

    it("give each scope's head as the newest entry it reads, so a visitor's work moves no one else's", () => {
      const at = (seq: number) => ({ seq, hash: log.get(seq, EVERYONE)?.hash });
      assert.deepEqual(log.headFor(null), at(4));
      assert.deepEqual(log.headFor(B), at(4));
      assert.deepEqual(log.headFor(A), at(5));
      assert.deepEqual(log.headFor(EVERYONE), log.head());
      assert.deepEqual(log.head(), at(5));
      assert.deepEqual(new Log(":memory:").headFor(A), { seq: 0, hash: "0".repeat(64) });
    });

    it("give one visitor's own entries, in order", () => {
      assert.deepEqual(seqs(log.own(A)), [2, 5]);
      assert.deepEqual(seqs(log.own(B)), [3]);
      assert.deepEqual(log.own(`guest:${"c".repeat(22)}`), []);
    });

    it("return full pages past 500 private entries, and never less than one entry", () => {
      for (let i = 0; i < 500; i += 1) log.append({ actor: "guest:a", type: "t", data: { i }, audience: A });
      log.append({ actor: "planner:p", type: "t", data: { n: 506 } });
      log.append({ actor: "planner:p", type: "t", data: { n: 507 } });
      assert.deepEqual(seqs(log.since(0, 3)), [1, 4, 506]);
      assert.deepEqual(seqs(log.since(4, 2)), [506, 507]);
      assert.deepEqual(seqs(log.since(0, 0)), [1]);
      assert.deepEqual(seqs(log.since(0, -1)), [1]);
      assert.equal(log.since(0, 1000, A).length, 506);
    });

    it("tell whether a visitor may see an entry", () => {
      const [shared, mine] = log.since(0, 2, A);
      assert.ok(shared && mine);
      assert.equal(visible(shared, null), true);
      assert.equal(visible(shared, B), true);
      assert.equal(visible(mine, A), true);
      assert.equal(visible(mine, B), false);
      assert.equal(visible(mine, null), false);
    });
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
