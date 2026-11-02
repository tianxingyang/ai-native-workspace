import { DatabaseSync, backup } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Run only after stopping the control service. Never overwrite an existing backup.
try {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination || !existsSync(source) || existsSync(destination) || resolve(source) === resolve(destination)) throw new Error('invalid_backup_paths');
  const db = new DatabaseSync(source, { readOnly: true, timeout: 1000 });
  try { await backup(db, destination); } finally { db.close(); }
  console.log(JSON.stringify({ event: 'backup_completed' }));
} catch { console.error(JSON.stringify({ event: 'backup_failed' })); process.exitCode = 1; }
