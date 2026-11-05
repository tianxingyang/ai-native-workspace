import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

let server, base;
test.beforeAll(async () => {
  const source = readFileSync(new URL('../web/pending-store.js', import.meta.url));
  server = createServer((request, response) => {
    response.setHeader('cache-control', 'no-store');
    response.setHeader('content-type', request.url === '/pending-store.js' ? 'text/javascript' : 'text/html');
    response.end(request.url === '/pending-store.js' ? source : '<!doctype html><title>Pending store test</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
async function initialize(page) {
  await page.goto(base);
  await page.evaluate(async () => {
    const { PendingStore } = await import('/pending-store.js');
    window.PendingStore = PendingStore; window.store = new PendingStore();
    window.secret = 'a'.repeat(64);
    window.record = { id: 'public-operation-id', text: 'PRIVATE message text', conversationId: 'PRIVATE room', threadId: 'PRIVATE thread', membershipGeneration: 'PRIVATE generation',
      replyToMessageId: 'parent-message', attachment: { name: 'PRIVATE-file.md', text: 'PRIVATE file contents' } };
    window.expiry = Date.now() + 600000;
    window.rows = async () => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('coseat-pending-v1', 1); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      try { return await new Promise((resolve, reject) => { const tx = db.transaction('pending'), r = tx.objectStore('pending').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); }); }
      finally { db.close(); }
    };
    window.writeRows = async (values) => {
      const db = await new Promise(resolve => { const r = indexedDB.open('coseat-pending-v1', 1); r.onsuccess = () => resolve(r.result); });
      try { await new Promise((resolve, reject) => { const tx = db.transaction('pending', 'readwrite'); for (const value of values) tx.objectStore('pending').put(value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
      finally { db.close(); }
    };
  });
}

test('real IndexedDB contains only encrypted content and reload restores the exact send intent', async ({ page }) => {
  await initialize(page);
  const evidence = await page.evaluate(async () => {
    await store.save(secret, record, expiry);
    const [row] = await rows();
    return { keys: Object.keys(row).sort(), serialized: JSON.stringify(row), ivBytes: row.iv.byteLength, cipherBytes: row.ciphertext.byteLength,
      recovered: await store.load(secret), original: record };
  });
  expect(evidence.keys).toEqual(['ciphertext', 'expiresAt', 'id', 'iv', 'slot']);
  expect(evidence.serialized).not.toContain('PRIVATE'); expect(evidence.serialized).not.toContain('a'.repeat(64));
  expect(evidence.ivBytes).toBe(12); expect(evidence.cipherBytes).toBeGreaterThan(16);
  expect(evidence.recovered).toEqual(evidence.original);
  await initialize(page);
  expect(await page.evaluate(async () => await store.load(secret))).toEqual(evidence.original);
});

test('different recovery keys are isolated and copying ciphertext to another slot fails authentication', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(secret, record, expiry);
    const second = 'b'.repeat(64), empty = await store.load(second), [original] = await rows();
    const slot = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(second)))].map(b => b.toString(16).padStart(2, '0')).join('');
    await writeRows([{ ...original, slot }]);
    return { empty, copied: await store.load(second), original: await store.load(secret), count: (await rows()).length };
  });
  expect(result.empty).toBeNull(); expect(result.copied).toBeNull(); expect(result.count).toBe(1);
  expect(result.original.text).toBe('PRIVATE message text');
});

test('AAD, IV, ciphertext tampering and expiry each clear the invalid record', async ({ page }) => {
  await initialize(page);
  const checks = await page.evaluate(async () => {
    const results = [];
    for (const kind of ['id', 'expiry', 'iv', 'ciphertext', 'expired']) {
      await store.save(secret, record, expiry);
      const [row] = await rows();
      if (kind === 'id') row.id = 'substituted-id';
      if (kind === 'expiry') row.expiresAt++;
      if (kind === 'expired') row.expiresAt = Date.now() - 1;
      if (kind === 'iv') row.iv[0] ^= 1;
      if (kind === 'ciphertext') new Uint8Array(row.ciphertext)[0] ^= 1;
      await writeRows([row]);
      results.push({ kind, value: await store.load(secret), count: (await rows()).length });
    }
    return results;
  });
  for (const result of checks) { expect(result.value, result.kind).toBeNull(); expect(result.count, result.kind).toBe(0); }
});

test('authenticated ciphertext must still have the bounded record schema and matching id', async ({ page }) => {
  await initialize(page);
  const results = await page.evaluate(async () => {
    const values = [{ ...record, id: 'different-id' }, { ...record, unexpected: 'not permitted' }, { ...record, text: 'x'.repeat(65537) },
      { ...record, membershipGeneration: null }, { ...record, attachment: { name: '../unsafe.txt', text: 'text' } }];
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16)), 'AES-GCM', false, ['encrypt']);
    const results = [];
    for (const value of values) {
      await store.save(secret, record, expiry); const [row] = await rows();
      row.ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: row.iv, additionalData: new TextEncoder().encode(JSON.stringify(['coseat-pending-v1', row.slot, row.id, row.expiresAt])) }, key, new TextEncoder().encode(JSON.stringify(value)));
      await writeRows([row]); results.push({ value: await store.load(secret), count: (await rows()).length });
    }
    return results;
  });
  for (const result of results) { expect(result.value).toBeNull(); expect(result.count).toBe(0); }
});

test('a pending id and payload are immutable; removal only accepts the matching operation', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(secret, record, expiry); const [first] = await rows();
    await store.save(secret, { ...record }, expiry + 1000); const [retry] = await rows();
    const errors = [];
    for (const value of [{ ...record, text: 'different' }, { ...record, id: 'second-id' }]) {
      try { await store.save(secret, value, expiry); } catch (error) { errors.push(error.message); }
    }
    await store.remove(secret, 'not-the-operation'); const kept = await store.load(secret);
    await store.remove(secret, record.id); const gone = await store.load(secret);
    await store.save(secret, record, expiry); const [fresh] = await rows();
    return { errors, kept, gone, immutable: retry.expiresAt === first.expiresAt && [...new Uint8Array(retry.ciphertext)].join() === [...new Uint8Array(first.ciphertext)].join(), freshIV: [...fresh.iv].join() !== [...first.iv].join() };
  });
  expect(result.errors).toEqual(['pending_storage_conflict', 'pending_storage_busy']);
  expect(result.kept.id).toBe('public-operation-id'); expect(result.gone).toBeNull(); expect(result.immutable).toBe(true); expect(result.freshIV).toBe(true);
});

test('two browser tabs cannot overwrite one another and exact concurrent retries recover safely', async ({ page, context }) => {
  await initialize(page); const second = await context.newPage(); await initialize(second);
  const writes = await Promise.all([page, second].map((tab, index) => tab.evaluate(async index => {
    try { await store.save(secret, { ...record, id: `tab-${index}` }, expiry); return 'saved'; } catch (error) { return error.message; }
  }, index)));
  expect(writes.sort()).toEqual(['pending_storage_busy', 'saved']);
  await page.evaluate(async () => { await store.remove(secret); });
  const identical = await Promise.all([page, second].map(tab => tab.evaluate(async () => {
    try { await store.save(secret, record, expiry); return 'saved'; } catch (error) { return error.message; }
  })));
  expect(identical).toEqual(['saved', 'saved']);
  expect(await page.evaluate(async () => (await rows()).length)).toBe(1);
  await second.close();
});

test('close preserves committed intent but prevents a delayed encryption from writing afterwards', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(secret, record, expiry); store.close();
    const recovered = await new PendingStore().load(secret);
    const late = new PendingStore(), nextSecret = 'b'.repeat(64), encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    crypto.subtle.encrypt = async (...args) => { started(); await gate; return encrypt(...args); };
    const pending = late.save(nextSecret, record, expiry).then(() => 'saved', error => error.message);
    await entered; late.close(); release();
    const outcome = await pending; crypto.subtle.encrypt = encrypt;
    return { recovered, outcome, count: (await rows()).length, late: await new PendingStore().load(nextSecret) };
  });
  expect(result.recovered.id).toBe('public-operation-id'); expect(result.outcome).toBe('pending_storage_unavailable'); expect(result.count).toBe(1); expect(result.late).toBeNull();
});

test('forget invalidates pending writes immediately and deletion completes even when close follows', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(secret, record, expiry);
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    crypto.subtle.encrypt = async (...args) => { started(); await gate; return encrypt(...args); };
    const pending = store.save(secret, record, expiry).then(() => 'saved', error => error.message);
    await entered; const cleanup = store.forget(secret); store.close(); await cleanup; release();
    const outcome = await pending; crypto.subtle.encrypt = encrypt;
    return { outcome, count: (await rows()).length, closed: await store.load(secret), fresh: await new PendingStore().load(secret) };
  });
  expect(result).toEqual({ outcome: 'pending_storage_unavailable', count: 0, closed: null, fresh: null });
});

test('bad-record cleanup cannot delete another tab replacement written while decryption was pending', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(secret, record, expiry);
    const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
    let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    crypto.subtle.decrypt = async () => { started(); await gate; throw new Error('tampered'); };
    const pending = store.load(secret); await entered;
    const replacement = new PendingStore(); await replacement.remove(secret, record.id);
    await replacement.save(secret, { ...record, id: 'new-operation' }, expiry);
    release(); const old = await pending; crypto.subtle.decrypt = decrypt;
    return { old, current: await replacement.load(secret) };
  });
  expect(result.old).toBeNull(); expect(result.current.id).toBe('new-operation');
});

test('forget only clears an observed row and delayed cleanup preserves a newly connected instance intent', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    await store.save(secret, record, expiry);
    await new PendingStore().forget(secret);
    const unseenKept = (await rows()).length;
    const open = indexedDB.open.bind(indexedDB);
    let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    indexedDB.open = (...args) => {
      const request = open(...args);
      Object.defineProperty(request, 'onsuccess', { set(callback) { request.addEventListener('success', () => { started(); void gate.then(() => callback.call(request)); }); } });
      return request;
    };
    const cleanup = store.forget(secret); store.close(); indexedDB.open = open;
    await entered;
    const fresh = new PendingStore(); await fresh.remove(secret, record.id);
    await fresh.save(secret, { ...record, id: 'fresh-connection-intent' }, expiry);
    release(); await cleanup;
    return { unseenKept, current: await fresh.load(secret), count: (await rows()).length };
  });
  expect(result.unseenKept).toBe(1); expect(result.count).toBe(1); expect(result.current.id).toBe('fresh-connection-intent');
});

test('storage capacity is bounded and expired entries are reclaimed before inserting a new slot', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    const secrets = Array.from({ length: 101 }, (_, index) => index.toString(16).padStart(64, '0'));
    await Promise.all(secrets.slice(0, 100).map(key => store.save(key, record, expiry)));
    let overflow; try { await store.save(secrets[100], record, expiry); } catch (error) { overflow = error.message; }
    const [expired] = await rows(); expired.expiresAt = Date.now() - 1; await writeRows([expired]);
    await store.save(secrets[100], record, expiry);
    return { overflow, count: (await rows()).length, recovered: await store.load(secrets[100]) };
  });
  expect(result.overflow).toBe('pending_storage_unavailable'); expect(result.count).toBe(100); expect(result.recovered.id).toBe('public-operation-id');
});

test('unavailable IndexedDB or encryption rejects saving without a silent memory fallback', async ({ page }) => {
  await initialize(page);
  const result = await page.evaluate(async () => {
    const open = indexedDB.open.bind(indexedDB), encrypt = crypto.subtle.encrypt.bind(crypto.subtle), errors = [];
    indexedDB.open = () => { throw new Error('storage disabled'); };
    try { await store.save(secret, record, expiry); } catch (error) { errors.push(error.message); }
    indexedDB.open = open; crypto.subtle.encrypt = async () => { throw new Error('crypto unavailable'); };
    try { await store.save(secret, record, expiry); } catch (error) { errors.push(error.message); }
    crypto.subtle.encrypt = encrypt;
    return { errors, value: await store.load(secret) };
  });
  expect(result.errors).toEqual(['pending_storage_unavailable', 'pending_storage_unavailable']); expect(result.value).toBeNull();
});

test('server deadlines survive reload and local clock correction, then expire on the injected server clock', async ({ page }) => {
  await initialize(page);
  const serverTime = 1900000000000, deadline = serverTime + 60000;
  const savedDeadline = await page.evaluate(async ({ serverTime, deadline }) => {
    const original = Date.now; Date.now = () => serverTime - 3600000;
    try {
      const store = new PendingStore(() => serverTime);
      await store.save(secret, record, deadline); store.close();
      return (await rows())[0].expiresAt;
    } finally { Date.now = original; }
  }, { serverTime, deadline });
  expect(savedDeadline).toBe(deadline);
  await initialize(page);
  const result = await page.evaluate(async ({ serverTime, deadline }) => {
    const original = Date.now; Date.now = () => serverTime + 86400000;
    let now = serverTime;
    try {
      const store = new PendingStore(() => now);
      const recovered = await store.load(secret);
      await store.save(secret, record, deadline);
      await store.save('b'.repeat(64), { ...record, id: 'second-intent' }, deadline + 60000);
      const beforeDeadline = (await rows()).length;
      Date.now = () => serverTime - 86400000; now = deadline;
      const expired = await store.load(secret), retained = await store.load('b'.repeat(64));
      let lateSave;
      try { await store.save(secret, record, deadline); } catch (error) { lateSave = error.message; }
      return { recovered, beforeDeadline, expired, retained, lateSave, count: (await rows()).length };
    } finally { Date.now = original; }
  }, { serverTime, deadline });
  expect(result.recovered.id).toBe('public-operation-id'); expect(result.beforeDeadline).toBe(2);
  expect(result.expired).toBeNull(); expect(result.retained.id).toBe('second-intent');
  expect(result.lateSave).toBe('pending_storage_unavailable'); expect(result.count).toBe(1);
});
