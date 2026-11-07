// The append-only log. Every change to the system is one entry here, and all
// other state is derived from these entries.
//
// Triggers stop ordinary writes from editing history. The hash chain makes
// edits detectable by anyone holding a past head hash, even if a person with
// database access removes the triggers and rewrites entries.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type NewEntry = {
  actor: string;
  type: string;
  studyId?: string | null;
  data: unknown;
};

export type Entry = {
  seq: number;
  at: string;
  actor: string;
  type: string;
  studyId: string | null;
  data: unknown;
  prevHash: string;
  hash: string;
};

export type Verification = { ok: true; entries: number; head: string } | { ok: false; brokenAt: number; reason: string };

const GENESIS = "0".repeat(64);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    study_id TEXT,
    data TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS log_study ON log (study_id);
  CREATE TRIGGER IF NOT EXISTS log_no_update BEFORE UPDATE ON log
    BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS log_no_delete BEFORE DELETE ON log
    BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
`;

// Key order must not change the hash.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type Hashed = Pick<Entry, "seq" | "at" | "actor" | "type" | "studyId" | "prevHash"> & { json: string };

function hashOf(e: Hashed): string {
  const body = JSON.stringify([e.seq, e.at, e.actor, e.type, e.studyId, e.json, e.prevHash]);
  return createHash("sha256").update(body).digest("hex");
}

type Row = {
  seq: number;
  at: string;
  actor: string;
  type: string;
  study_id: string | null;
  data: string;
  prev_hash: string;
  hash: string;
};

const toEntry = (r: Row): Entry => ({
  seq: r.seq,
  at: r.at,
  actor: r.actor,
  type: r.type,
  studyId: r.study_id,
  data: JSON.parse(r.data),
  prevHash: r.prev_hash,
  hash: r.hash,
});

export class Log {
  readonly db: DatabaseSync;
  private readonly clock: () => Date;
  private readonly listeners = new Set<(entry: Entry) => void>();

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.clock = clock;
  }

  head(): { seq: number; hash: string } {
    const row = this.db.prepare("SELECT seq, hash FROM log ORDER BY seq DESC LIMIT 1").get() as
      | { seq: number; hash: string }
      | undefined;
    return row ?? { seq: 0, hash: GENESIS };
  }

  append(entry: NewEntry): Entry {
    const { seq: lastSeq, hash: prevHash } = this.head();
    const json = canonical(entry.data);
    const hashed: Hashed = {
      seq: lastSeq + 1,
      at: this.clock().toISOString(),
      actor: entry.actor,
      type: entry.type,
      studyId: entry.studyId ?? null,
      json,
      prevHash,
    };
    const hash = hashOf(hashed);
    this.db
      .prepare("INSERT INTO log (seq, at, actor, type, study_id, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(hashed.seq, hashed.at, hashed.actor, hashed.type, hashed.studyId, json, prevHash, hash);
    const written: Entry = { ...hashed, data: JSON.parse(json), hash };
    for (const listener of this.listeners) listener(written);
    return written;
  }

  since(seq: number, limit = 1000): Entry[] {
    const rows = this.db.prepare("SELECT * FROM log WHERE seq > ? ORDER BY seq LIMIT ?").all(seq, limit) as Row[];
    return rows.map(toEntry);
  }

  subscribe(listener: (entry: Entry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  verify(): Verification {
    let prevHash = GENESIS;
    let expected = 1;
    let entries = 0;
    for (const raw of this.db.prepare("SELECT * FROM log ORDER BY seq").iterate()) {
      const row = raw as Row;
      if (row.seq !== expected) return { ok: false, brokenAt: expected, reason: "An entry is missing" };
      if (row.prev_hash !== prevHash) return { ok: false, brokenAt: row.seq, reason: "Link to the previous entry is broken" };
      const hash = hashOf({
        seq: row.seq,
        at: row.at,
        actor: row.actor,
        type: row.type,
        studyId: row.study_id,
        json: row.data,
        prevHash: row.prev_hash,
      });
      if (hash !== row.hash) return { ok: false, brokenAt: row.seq, reason: "Entry does not match its hash" };
      prevHash = row.hash;
      expected += 1;
      entries += 1;
    }
    return { ok: true, entries, head: prevHash };
  }

  close() {
    this.db.close();
  }
}
