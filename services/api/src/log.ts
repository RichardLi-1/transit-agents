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
//
// An entry with an audience belongs to one visitor's sandbox: only that visitor
// sees it. Entries with none are the shared record, which every read shows. The
// audience is in the hash only when set, so older entries keep their hashes.
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type NewEntry = {
  actor: string;
  type: string;
  studyId?: string | null;
  data: unknown;
  audience?: string | null;
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
  audience: string | null;
};

// Which entries a read returns: null for the shared record only, an audience for
// the shared record plus that visitor's own entries, EVERYONE for all of them.
export const EVERYONE = Symbol("everyone");
export type Scope = string | null | typeof EVERYONE;

export const visible = (entry: Pick<Entry, "audience">, audience: string | null) => !entry.audience || entry.audience === audience;

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
    hash TEXT NOT NULL UNIQUE,
    audience TEXT
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

type Chained = Pick<Entry, "seq" | "at" | "actor" | "type" | "studyId" | "payloadHash" | "prevHash" | "audience">;

const hashOf = (e: Chained) =>
  sha256(JSON.stringify([e.seq, e.at, e.actor, e.type, e.studyId, e.payloadHash, e.prevHash, ...(e.audience ? [e.audience] : [])]));

type Row = {
  seq: number;
  at: string;
  actor: string;
  type: string;
  study_id: string | null;
  payload_hash: string;
  prev_hash: string;
  hash: string;
  audience: string | null;
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
  audience: r.audience,
});

// The SQL that limits a read to a scope, and its parameters.
const within = (scope: Scope): [string, string[]] =>
  scope === EVERYONE
    ? ["", []]
    : scope === null
      ? [" AND log.audience IS NULL", []]
      : [" AND (log.audience IS NULL OR log.audience = ?)", [scope]];

export class Log {
  readonly db: DatabaseSync;
  private readonly clock: () => Date;
  private readonly listeners = new Set<(entry: Entry) => void>();

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(SCHEMA);
    // A log made before audiences gains the column first, then its index.
    const columns = this.db.prepare("PRAGMA table_info(log)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "audience")) this.db.exec("ALTER TABLE log ADD COLUMN audience TEXT");
    this.db.exec("CREATE INDEX IF NOT EXISTS log_audience ON log (audience, seq)");
    this.clock = clock;
  }

  // The newest entry of all.
  head(): { seq: number; hash: string } {
    return this.headFor(EVERYONE);
  }

  // The newest entry a scope reads. A visitor's work moves only their own head and
  // the whole log's, so nobody else can tell from theirs when visitors work.
  headFor(scope: Scope): { seq: number; hash: string } {
    const [where, params] = within(scope);
    const row = this.db.prepare(`SELECT seq, hash FROM log WHERE TRUE${where} ORDER BY seq DESC LIMIT 1`).get(...params) as
      | { seq: number; hash: string }
      | undefined;
    return row ? { seq: row.seq, hash: row.hash } : { seq: 0, hash: GENESIS };
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
      audience: entry.audience || null,
    };
    const hash = hashOf(chained);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("INSERT INTO payloads (hash, json) VALUES (?, ?)").run(payloadHash, json);
      this.db
        .prepare("INSERT INTO log (seq, at, actor, type, study_id, payload_hash, prev_hash, hash, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(chained.seq, chained.at, chained.actor, chained.type, chained.studyId, payloadHash, prevHash, hash, chained.audience);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    const written: Entry = { ...chained, data: JSON.parse(json), hash };
    for (const listener of this.listeners) listener(written);
    return written;
  }

  get(seq: number, scope: Scope = null): Entry | undefined {
    const [where, params] = within(scope);
    const row = this.db.prepare(`${SELECT} WHERE log.seq = ?${where}`).get(seq, ...params) as Row | undefined;
    return row && toEntry(row);
  }

  // Filtered in SQL, so a page is full however many entries others can't see.
  since(seq: number, limit = 1000, scope: Scope = null): Entry[] {
    const [where, params] = within(scope);
    const count = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
    const rows = this.db.prepare(`${SELECT} WHERE log.seq > ?${where} ORDER BY log.seq LIMIT ?`).all(seq, ...params, count) as Row[];
    return rows.map(toEntry);
  }

  // One visitor's own entries, in order.
  own(audience: string): Entry[] {
    const rows = this.db.prepare(`${SELECT} WHERE log.audience = ? ORDER BY log.seq`).all(audience) as Row[];
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
        audience: row.audience,
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
