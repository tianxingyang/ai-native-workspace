/** Encrypted, atomic scope checkpoints. Keys are issued by the authenticated
 * session and remain in memory. Restored content is quarantined until /sync. */
const DATABASE = 'coseat-sync-v1', STORE = 'checkpoints', LIMIT = 4 * 1024 * 1024, MAX_SLOTS = 100;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const failure = () => new Error('sync_storage_unavailable');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
const optional = value => value === undefined || text(value);
const bytes = value => value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;
function validate(value) {
  const keys = ['version', 'identity', 'messages', 'runs', 'cursor', 'streamId', 'pendingReadMessageId', 'pendingReadMessageIds'];
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key)) || value.version !== 1
      || !Array.isArray(value.identity) || value.identity.length !== 4 || !value.identity.every(text)
      || !optional(value.cursor) || !text(value.streamId) || !optional(value.pendingReadMessageId)) throw failure();
  for (const name of ['messages', 'runs']) {
    const rows = value[name];
    if (!Array.isArray(rows) || rows.length > 10000 || rows.some(row => !object(row) || !text(row.id))
        || new Set(rows.map(row => row.id)).size !== rows.length) throw failure();
  }
  if (value.pendingReadMessageIds !== undefined && (!Array.isArray(value.pendingReadMessageIds) || value.pendingReadMessageIds.length > 100 || !value.pendingReadMessageIds.every(text))) throw failure();
  if (value.pendingReadMessageId && !value.messages.some(row => row.id === value.pendingReadMessageId)) throw failure();
  return value;
}
const aad = row => encoder.encode(JSON.stringify([DATABASE, row.slot, row.revision, row.expiresAt, row.readEpoch]));
async function material(secret) {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) throw failure();
  const hash = async label => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`${DATABASE}:${label}:${secret.toLowerCase()}`)));
  const slot = [...await hash('slot')].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const raw = await hash('key'), key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0); return { slot, key };
}
function open() {
  return new Promise((resolve, reject) => {
    let rejected = false;
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'slot' });
    request.onerror = request.onblocked = () => { rejected = true; reject(failure()); };
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
  });
}
export class SyncStore {
  #material; #now; #revision; #intents = new Set(); #stream; #readEpoch = 'initial'; #loaded = false; #closed = false; #tail = Promise.resolve(); #transactions = new Set();
  constructor(secret, now = Date.now) {
    // Defer derivation so unavailable storage does not create an unhandled rejection.
    this.#material = () => material(secret); this.#now = now;
  }
  #queue(operation) {
    const result = this.#tail.then(operation); this.#tail = result.catch(() => {}); return result;
  }
  #require() { if (this.#closed || !Number.isFinite(this.#now())) throw failure(); }
  async #transaction(mode, operation, cleanup = false) {
    const db = await open();
    try {
      if (!cleanup) this.#require();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode); this.#transactions.add(tx); let result;
        tx.oncomplete = () => { this.#transactions.delete(tx); resolve(result); };
        tx.onerror = tx.onabort = () => { this.#transactions.delete(tx); reject(failure()); };
        try { operation(tx.objectStore(STORE), value => { result = value; }); }
        catch { tx.abort(); }
      });
    } finally { db.close(); }
  }
  load(identity) {
    return this.#queue(async () => {
      this.#require(); const { slot, key } = await this.#material(); this.#require();
      const row = await this.#transaction('readonly', (store, done) => { const request = store.get(slot); request.onsuccess = () => done(request.result); });
      this.#require(); this.#loaded = true; this.#revision = row?.revision; this.#readEpoch = !row?.deleted && text(row?.readEpoch) ? row.readEpoch : 'initial';
      this.#intents.clear(); this.#stream = undefined;
      if (!row || row.deleted) return null;
      try {
        if (!text(row.revision) || !text(row.readEpoch) || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= this.#now()
            || bytes(row.iv)?.length !== 12 || !bytes(row.ciphertext) || bytes(row.ciphertext).length > LIMIT + 16) throw failure();
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData: aad(row) }, key, row.ciphertext);
        const value = validate(JSON.parse(decoder.decode(plain))); this.#require();
        if (row.expiresAt <= this.#now() || JSON.stringify(value.identity) !== JSON.stringify(identity)) throw failure();
        this.#stream = value.streamId; this.#intents = new Set([...(value.pendingReadMessageIds ?? []), ...(value.pendingReadMessageId ? [value.pendingReadMessageId] : [])]);
        return value;
      } catch {
        await this.#replace(slot, { slot, revision: crypto.randomUUID(), deleted: true, expiresAt: row.expiresAt });
        this.#readEpoch = 'initial'; this.#intents.clear(); this.#stream = undefined;
        return null;
      }
    });
  }
  async #replace(slot, row) {
    const expected = this.#revision;
    const saved = await this.#transaction('readwrite', (store, done) => {
      const request = store.getAll();
      request.onsuccess = () => {
        const current = request.result.find(item => item.slot === slot);
        if (current?.revision !== expected) { done(false); return; }
        const live = request.result.filter(item => {
          if (item.slot !== slot && (!Number.isSafeInteger(item.expiresAt) || item.expiresAt <= this.#now())) { store.delete(item.slot); return false; }
          return true;
        });
        if (!current && live.length >= MAX_SLOTS) { store.transaction.abort(); return; }
        store.put(row); done(true);
      };
    });
    if (saved) this.#revision = row.revision;
    return saved;
  }
  save(input, expiresAt, { confirmedMessageId, discardReadIntent = false } = {}) {
    // Capture at call time: a later mutation must never be paired with an old cursor.
    let plain;
    try { plain = encoder.encode(JSON.stringify(validate(input))); if (plain.length > LIMIT) throw failure(); }
    catch { return Promise.reject(failure()); }
    return this.#queue(async () => {
      this.#require(); if (!this.#loaded || !Number.isSafeInteger(expiresAt) || expiresAt <= this.#now()) throw failure();
      const { slot, key } = await this.#material(); this.#require();
      let next = JSON.parse(decoder.decode(plain));
      if (discardReadIntent || this.#stream !== next.streamId) this.#intents.clear();
      this.#stream = next.streamId;
      const previousReadEpoch = this.#readEpoch;
      const nextReadEpoch = discardReadIntent ? crypto.randomUUID() : previousReadEpoch;
      for (let attempt = 0; attempt < 4; attempt++) {
        if (next.pendingReadMessageId) this.#intents.add(next.pendingReadMessageId);
        const confirmed = next.messages.findIndex(message => message.id === confirmedMessageId);
        for (const target of this.#intents) {
          const index = next.messages.findIndex(message => message.id === target);
          if (index >= 0 && (index <= confirmed || next.messages[index].retracted || next.messages[index].invalidated)) this.#intents.delete(target);
        }
        // Reading is monotonic: one farthest retained target covers earlier
        // observations. Keep only unknown foreign IDs alongside that target.
        const known = next.messages.filter(message => this.#intents.has(message.id));
        for (const message of known.slice(0, -1)) this.#intents.delete(message.id);
        if (this.#intents.size > 100) throw failure();
        next.pendingReadMessageIds = [...this.#intents];
        plain = encoder.encode(JSON.stringify(next)); if (plain.length > LIMIT) throw failure();
        const row = { slot, revision: crypto.randomUUID(), readEpoch: nextReadEpoch, expiresAt, iv: crypto.getRandomValues(new Uint8Array(12)) };
        row.ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: row.iv, additionalData: aad(row) }, key, plain);
        this.#require(); if (expiresAt <= this.#now()) throw failure();
        if (await this.#replace(slot, row)) { this.#readEpoch = nextReadEpoch; return; }
        const current = await this.#transaction('readonly', (store, done) => { const request = store.get(slot); request.onsuccess = () => done(request.result); });
        this.#require();
        // Logout/denial fences this open instance. A newly authenticated instance
        // may load the tombstone and start fresh, but an old tab cannot revive it.
        if (!current || current.deleted) { this.close(); throw failure(); }
        if (!text(current.revision) || !text(current.readEpoch) || !Number.isSafeInteger(current.expiresAt) || current.expiresAt <= this.#now()
            || bytes(current.iv)?.length !== 12 || !bytes(current.ciphertext) || bytes(current.ciphertext).length > LIMIT + 16) throw failure();
        if (current.readEpoch !== previousReadEpoch) throw new Error('sync_checkpoint_reset');
        const previous = validate(JSON.parse(decoder.decode(await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: current.iv, additionalData: aad(current) }, key, current.ciphertext))));
        if (JSON.stringify(previous.identity) !== JSON.stringify(next.identity)) throw failure();
        if (previous.streamId !== next.streamId && !discardReadIntent) throw failure();
        // Keep fixed observed IDs from other tabs even when their newer messages
        // are not in this baseline yet. Recovery validates them against /sync
        // before choosing the farthest retained target; no content is revived.
        if (!discardReadIntent && previous.streamId === next.streamId) {
          for (const target of [...(previous.pendingReadMessageIds ?? []), ...(previous.pendingReadMessageId ? [previous.pendingReadMessageId] : [])]) this.#intents.add(target);
        }
        this.#revision = current.revision;
      }
      throw failure();
    });
  }
  forget(expiresAt) {
    this.close();
    return (async () => {
      const { slot } = await this.#material();
      // Keep a non-content tombstone so an already-open tab cannot resurrect data.
      await this.#transaction('readwrite', store => store.put({ slot, revision: crypto.randomUUID(), deleted: true, expiresAt }), true);
    })();
  }
  close() {
    this.#closed = true;
    for (const tx of this.#transactions) { try { tx.abort(); } catch { /* Completed. */ } }
  }
}
