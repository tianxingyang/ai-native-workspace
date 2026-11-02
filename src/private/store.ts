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
  close(): void { this.db.close(); }
}
