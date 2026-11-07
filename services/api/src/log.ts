// The append-only log. Every change to the system is one entry here, and all
// other state is derived from these entries.
//
// Each entry's content is stored apart from the chain, which records only the
// content's hash. That lets an agency remove content it must dispose of or sever,
// such as a member of the public's comment, while the chain still verifies and
// still shows that something was there.
//
// Triggers stop ordinary writes from editing history. The hash chain makes edits
// detectable by anyone holding an earlier head hash, even if a person with
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
  payloadHash: string;
  prevHash: string;
  hash: string;
};

export type Verification = { ok: true; entries: number; head: string } | { ok: false; brokenAt: number; reason: string };

export const REDACTED = { redacted: true } as const;

const GENESIS = "0".repeat(64);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS log (
    seq INTEGER PRIMARY KEY,
    at TEXT NOT NULL,
    actor TEXT NOT NULL,
    type TEXT NOT NULL,
    study_id TEXT,
    payload_hash TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE
  );
  CREATE INDEX IF NOT EXISTS log_study ON log (study_id);
  CREATE TABLE IF NOT EXISTS payloads (
    hash TEXT PRIMARY KEY,
    json TEXT NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS log_no_update BEFORE UPDATE ON log
    BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS log_no_delete BEFORE DELETE ON log
    BEGIN SELECT RAISE(ABORT, 'log is append-only'); END;
  CREATE TRIGGER IF NOT EXISTS payloads_no_update BEFORE UPDATE ON payloads
    BEGIN SELECT RAISE(ABORT, 'payloads can be removed, not changed'); END;
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

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

type Chained = Pick<Entry, "seq" | "at" | "actor" | "type" | "studyId" | "payloadHash" | "prevHash">;

const hashOf = (e: Chained) => sha256(JSON.stringify([e.seq, e.at, e.actor, e.type, e.studyId, e.payloadHash, e.prevHash]));

type Row = {
  seq: number;
  at: string;
  actor: string;
  type: string;
  study_id: string | null;
  payload_hash: string;
  prev_hash: string;
  hash: string;
  json: string | null;
};

const SELECT = "SELECT log.*, payloads.json FROM log LEFT JOIN payloads ON payloads.hash = log.payload_hash";

const toEntry = (r: Row): Entry => ({
  seq: r.seq,
  at: r.at,
  actor: r.actor,
  type: r.type,
  studyId: r.study_id,
  data: r.json === null ? REDACTED : JSON.parse(r.json),
  payloadHash: r.payload_hash,
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
    // The sequence number is part of the payload hash, so two identical payloads
    // still get separate rows and removing one never removes the other.
    const payloadHash = sha256(`${lastSeq + 1}:${json}`);
    const chained: Chained = {
      seq: lastSeq + 1,
      at: this.clock().toISOString(),
      actor: entry.actor,
      type: entry.type,
      studyId: entry.studyId ?? null,
      payloadHash,
      prevHash,
    };
    const hash = hashOf(chained);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO payloads (hash, json) VALUES (?, ?)").run(payloadHash, json);
      this.db
        .prepare("INSERT INTO log (seq, at, actor, type, study_id, payload_hash, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(chained.seq, chained.at, chained.actor, chained.type, chained.studyId, payloadHash, prevHash, hash);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const written: Entry = { ...chained, data: JSON.parse(json), hash };
    for (const listener of this.listeners) listener(written);
    return written;
  }

  get(seq: number): Entry | undefined {
    const row = this.db.prepare(`${SELECT} WHERE log.seq = ?`).get(seq) as Row | undefined;
    return row && toEntry(row);
  }

  since(seq: number, limit = 1000): Entry[] {
    const rows = this.db.prepare(`${SELECT} WHERE log.seq > ? ORDER BY log.seq LIMIT ?`).all(seq, limit) as Row[];
    return rows.map(toEntry);
  }

  // Removes an entry's content, keeping the entry and its place in the chain.
  removePayload(seq: number): boolean {
    const entry = this.db.prepare("SELECT payload_hash FROM log WHERE seq = ?").get(seq) as { payload_hash: string } | undefined;
    if (!entry) return false;
    this.db.prepare("DELETE FROM payloads WHERE hash = ?").run(entry.payload_hash);
    return true;
  }

  subscribe(listener: (entry: Entry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  verify(): Verification {
    let prevHash = GENESIS;
    let expected = 1;
    let entries = 0;
    for (const raw of this.db.prepare(`${SELECT} ORDER BY log.seq`).iterate()) {
      const row = raw as Row;
      if (row.seq !== expected) return { ok: false, brokenAt: expected, reason: "An entry is missing" };
      if (row.prev_hash !== prevHash) return { ok: false, brokenAt: row.seq, reason: "Link to the previous entry is broken" };
      const hash = hashOf({
        seq: row.seq,
        at: row.at,
        actor: row.actor,
        type: row.type,
        studyId: row.study_id,
        payloadHash: row.payload_hash,
        prevHash: row.prev_hash,
      });
      if (hash !== row.hash) return { ok: false, brokenAt: row.seq, reason: "Entry does not match its hash" };
      if (row.json !== null && sha256(`${row.seq}:${row.json}`) !== row.payload_hash) {
        return { ok: false, brokenAt: row.seq, reason: "Content does not match its hash" };
      }
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
