import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
let server, base;
test.beforeAll(async () => {
  const source = readFileSync(new URL('../web/sync-store.js', import.meta.url));
  server = createServer((request, response) => {
    response.setHeader('content-type', request.url === '/sync-store.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/sync-store.js' ? source : '<!doctype html><title>Sync store test</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
async function initialize(page) {
  await page.goto(base);
  await page.evaluate(async () => {
    const { SyncStore } = await import('/sync-store.js'); window.SyncStore = SyncStore;
    window.secret = 'a'.repeat(64); window.expiry = Date.now() + 600000;
    window.record = { version: 1, identity: ['PRIVATE member', 'PRIVATE room', 'PRIVATE thread', 'PRIVATE generation'],
      messages: [{ id: 'm1', text: 'PRIVATE body' }], pendingReadMessageIds: ['m1'], runs: [{ id: 'r1', result: 'PRIVATE output' }], cursor: 'cursor-1', streamId: 'stream', pendingReadMessageId: 'm1' };
    window.store = new SyncStore(secret); await store.load(record.identity);
    window.rows = async (operation = 'getAll', value) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('coseat-sync-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { return await new Promise((resolve, reject) => {
        const tx = db.transaction('checkpoints', operation === 'getAll' ? 'readonly' : 'readwrite');
        const request = tx.objectStore('checkpoints')[operation](value); let result;
        request.onsuccess = () => { result = request.result; }; tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = reject;
      }); } finally { db.close(); }
    };
  });
}
test('one ciphertext atomically restores baseline, cursor and fixed read intent without persisting secrets', async ({ page }) => {
  await initialize(page);
  const saved = await page.evaluate(async () => { await store.save(record, expiry); return { rows: await rows(), record }; });
  expect(Object.keys(saved.rows[0]).sort()).toEqual(['ciphertext', 'expiresAt', 'iv', 'readEpoch', 'revision', 'slot']);
  expect(JSON.stringify(saved.rows)).not.toContain('PRIVATE'); expect(JSON.stringify(saved.rows)).not.toContain('a'.repeat(64));
  await initialize(page); expect(await page.evaluate(() => store.load(record.identity))).toEqual(saved.record);
});
test('an aborted transaction leaves the entire previous checkpoint and retry commits the entire new one', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(record, expiry); const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) { const result = original.apply(this, args); this.transaction.abort(); return result; };
    const next = { ...record, cursor: 'cursor-2', messages: [...record.messages, { id: 'm2', text: 'new' }], pendingReadMessageId: 'm2' };
    let failed = false; try { await store.save(next, expiry); } catch { failed = true; }
    IDBObjectStore.prototype.put = original;
    const reader = new SyncStore(secret), before = await reader.load(record.identity);
    await store.save(next, expiry); const after = await reader.load(record.identity);
    return { failed, before, after, record, next: { ...next, pendingReadMessageIds: ['m2'] } };
  });
  expect(result.failed).toBe(true); expect(result.before).toEqual(result.record); expect(result.after).toEqual(result.next);
});
test('competing tabs reconcile coherent checkpoints but cannot resurrect a logout tombstone', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(record, expiry); const stale = new SyncStore(secret); await stale.load(record.identity);
    await store.save({ ...record, cursor: 'cursor-2' }, expiry);
    let rejected = false; try { await stale.save(record, expiry); } catch { rejected = true; }
    const current = new SyncStore(secret); await current.load(record.identity);
    await store.forget(expiry);
    let resurrected = false; try { await current.save(record, expiry); resurrected = true; } catch {}
    return { rejected, resurrected, recovered: await new SyncStore(secret).load(record.identity), rows: await rows() };
  });
  expect(result.rejected).toBe(false); expect(result.resurrected).toBe(false); expect(result.recovered).toBeNull();
  expect(result.rows[0].deleted).toBe(true); expect(result.rows[0].ciphertext).toBeUndefined();
});
test('logout fences delayed encryption and removes previously encrypted content', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(record, expiry); const original = crypto.subtle.encrypt.bind(crypto.subtle);
    let arrived, release; const ready = new Promise(resolve => { arrived = resolve; }); const hold = new Promise(resolve => { release = resolve; });
    crypto.subtle.encrypt = async (...args) => { arrived(); await hold; return original(...args); };
    const writing = store.save({ ...record, cursor: 'late' }, expiry).then(() => false, () => true);
    await ready; const forgetting = store.forget(expiry); release(); const rejected = await writing; await forgetting;
    crypto.subtle.encrypt = original; return { rejected, recovered: await new SyncStore(secret).load(record.identity) };
  });
  expect(result).toEqual({ rejected: true, recovered: null });
});
test('tampering, schema mismatch, wrong identity and expired ciphertext never restore content', async ({ page }) => {
  await initialize(page);
  const checks = await page.evaluate(async () => {
    const results = [];
    for (const kind of ['iv', 'ciphertext', 'expiresAt', 'identity', 'expiry']) {
      const writer = new SyncStore(secret); await writer.load(record.identity); await writer.save(record, expiry);
      const [row] = await rows();
      if (kind === 'iv') row.iv[0] ^= 1;
      if (kind === 'ciphertext') new Uint8Array(row.ciphertext)[0] ^= 1;
      if (kind === 'expiresAt') row.expiresAt++;
      await rows('put', row);
      const reader = new SyncStore(secret, kind === 'expiry' ? () => expiry : Date.now);
      results.push(await reader.load(kind === 'identity' ? ['wrong', ...record.identity.slice(1)] : record.identity));
    }
    const other = await new SyncStore('b'.repeat(64)).load(record.identity);
    return [...results, other];
  });
  expect(checks).toEqual([null, null, null, null, null, null]);
});

test('a competing tab retains the farther seen target and can persist again after catching up', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(record, expiry); const second = new SyncStore(secret); await second.load(record.identity);
    const next = { ...record, cursor: 'cursor-2', messages: [...record.messages, { id: 'm2', text: 'new' }], pendingReadMessageId: 'm2' };
    await store.save(next, expiry);
    let failed = false; try { await second.save(record, expiry); } catch { failed = true; }
    await second.save({ ...next, pendingReadMessageId: 'm1' }, expiry);
    return { failed, recovered: await new SyncStore(secret).load(record.identity) };
  });
  expect(result.failed).toBe(false); expect(result.recovered.pendingReadMessageIds).toContain('m2');
});
test('successful commits sweep expired orphan slots and invalid schema never replaces a checkpoint', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(record, expiry);
    await rows('put', { slot: 'expired-orphan', revision: 'old', expiresAt: Date.now() - 1, ciphertext: new Uint8Array([1]) });
    await store.save(record, expiry);
    let rejected = false; try { await store.save({ ...record, version: 2 }, expiry); } catch { rejected = true; }
    return { count: (await rows()).length, rejected, recovered: await new SyncStore(secret).load(record.identity) };
  });
  expect(result.count).toBe(1); expect(result.rejected).toBe(true); expect(result.recovered.cursor).toBe('cursor-1');
});

test('a same-stream reset fences another tab from resurrecting pre-reset reading intent', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(record, expiry); const stale = new SyncStore(secret); await stale.load(record.identity);
    await store.save({ ...record, pendingReadMessageId: undefined, pendingReadMessageIds: [] }, expiry, { discardReadIntent: true });
    let error; try { await stale.save(record, expiry); } catch (failure) { error = failure.message; }
    return { error, checkpoint: await new SyncStore(secret).load(record.identity) };
  });
  expect(result.error).toBe('sync_checkpoint_reset'); expect(result.checkpoint.pendingReadMessageIds).toEqual([]);
  expect(result.checkpoint.pendingReadMessageId).toBeUndefined();
});

test('malformed persisted reset generation is discarded and a fresh checkpoint remains recoverable', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(record, expiry); const [row] = await rows(); row.readEpoch = 7; await rows('put', row);
    const recovering = new SyncStore(secret), invalid = await recovering.load(record.identity);
    await recovering.save(record, expiry);
    return { invalid, recovered: await new SyncStore(secret).load(record.identity) };
  });
  expect(result.invalid).toBeNull(); expect(result.recovered.messages[0].text).toBe('PRIVATE body');
});

test('many unconfirmed observations compact to the farthest target without exhausting storage', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    for (let index = 2; index <= 105; index++) {
      record.messages.push({ id: `m${index}`, text: 'seen' }); record.pendingReadMessageId = `m${index}`;
      await store.save(record, expiry);
    }
    return await new SyncStore(secret).load(record.identity);
  });
  expect(result.pendingReadMessageIds).toEqual(['m105']);
});
