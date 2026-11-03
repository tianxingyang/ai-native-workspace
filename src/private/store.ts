import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { requireCondition } from '../contracts.js';

/** Small single-instance trial: one bounded aggregate commits all related facts atomically. */
export class SnapshotStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path, { timeout: 1000 });
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, body TEXT NOT NULL) STRICT;');
      this.db.exec('CREATE TABLE IF NOT EXISTS authorization_audit (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL) STRICT;');
      // Retain SQLite's exclusive lock for this connection; a second service must fail startup.
      this.db.exec('BEGIN EXCLUSIVE; COMMIT;');
    } catch (error) { this.db.close(); throw error; }
  }
  load<T>(): T | undefined {
    const row = this.db.prepare('SELECT version, body FROM snapshot WHERE id=1').get();
    if (!row) return undefined;
    requireCondition(row.version === 1, 500, 'unsupported_database_version');
    return JSON.parse(String(row.body)) as T;
  }
  save(value: unknown): void {
    const body = JSON.stringify(value);
    requireCondition(Buffer.byteLength(body) <= 8 * 1024 * 1024, 507, 'trial_storage_limit');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO snapshot(id, version, body) VALUES(1,1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(body);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  loadAudit<T>(): T | undefined {
    const row = this.db.prepare('SELECT body FROM authorization_audit WHERE id=1').get();
    return row ? JSON.parse(String(row.body)) as T : undefined;
  }
  saveAudit(entries: readonly unknown[]): void {
    // Its own atomic SQLite transaction, independent of business rollback and snapshot size limits.
    this.db.prepare('INSERT INTO authorization_audit(id, body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(entries.slice(-1000)));
  }
  close(): void { this.db.close(); }
}
