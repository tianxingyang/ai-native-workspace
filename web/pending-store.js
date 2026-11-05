/** One encrypted, immutable send intent per server-issued recovery secret.
 * Secrets and CryptoKeys remain in memory; this module never sends messages. */
const DATABASE = 'coseat-pending-v1', STORE = 'pending', LIMIT = 65536;
const encoder = new TextEncoder(), decoder = new TextDecoder('utf-8', { fatal: true });
const unavailable = () => new Error('pending_storage_unavailable');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Surrogate}/u.test(value);
const exact = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const secretValue = secret => {
  if (typeof secret !== 'string' || !/^[a-f0-9]{64}$/i.test(secret)) throw unavailable();
  return secret.toLowerCase();
};
function recordValue(value) {
  if (!exact(value, ['id', 'text', 'replyToMessageId', 'attachment', 'conversationId', 'threadId', 'membershipGeneration'])
    || !string(value.id, 128) || !string(value.text, 8000) || !value.text.trim()
    || !string(value.conversationId, 128) || !string(value.threadId, 128) || !string(value.membershipGeneration, 128)
    || (value.replyToMessageId !== undefined && !string(value.replyToMessageId, 128))) throw unavailable();
  const record = { id: value.id, text: value.text, conversationId: value.conversationId, threadId: value.threadId, membershipGeneration: value.membershipGeneration };
  if (value.replyToMessageId !== undefined) record.replyToMessageId = value.replyToMessageId;
  if (value.attachment !== undefined) {
    const file = value.attachment;
    if (!exact(file, ['name', 'text']) || !string(file.name, 120) || file.name.trim() !== file.name || !/\S\.(txt|md)$/i.test(file.name)
      || /[\\/\x00-\x1f\x7f<>:"|?*\u202a-\u202e\u2066-\u2069]/u.test(file.name)
      || !string(file.text, 8192) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(file.text) || encoder.encode(file.text).length > 8192) throw unavailable();
    record.attachment = { name: file.name, text: file.text };
  }
  if (encoder.encode(JSON.stringify(record)).length > LIMIT) throw unavailable();
  return record;
}
const bytes = value => value instanceof ArrayBuffer ? new Uint8Array(value) : value instanceof Uint8Array ? value : null;
const equalBytes = (a, b) => { const x = bytes(a), y = bytes(b); return x && y && x.length === y.length && x.every((v, i) => v === y[i]); };
function envelope(row, slot) {
  return exact(row, ['slot', 'id', 'iv', 'ciphertext', 'expiresAt']) && row.slot === slot && string(row.id, 128)
    && Number.isSafeInteger(row.expiresAt) && row.expiresAt > 0 && bytes(row.iv)?.length === 12
    && bytes(row.ciphertext)?.length >= 16 && bytes(row.ciphertext).length <= LIMIT + 16;
}
const sameRow = (a, b) => a && b && a.slot === b.slot && a.id === b.id && a.expiresAt === b.expiresAt && equalBytes(a.iv, b.iv) && equalBytes(a.ciphertext, b.ciphertext);
const aad = row => encoder.encode(JSON.stringify([DATABASE, row.slot, row.id, row.expiresAt]));
async function material(secret) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(secret)));
  const slot = [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('');
  const raw = Uint8Array.from(secret.match(/../g), pair => parseInt(pair, 16));
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  raw.fill(0);
  return { slot, key };
}
async function decrypt(row, slot, key, now) {
  if (!envelope(row, slot) || row.expiresAt <= now) throw unavailable();
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv, additionalData: aad(row) }, key, row.ciphertext);
  if (plain.byteLength > LIMIT) throw unavailable();
  const record = recordValue(JSON.parse(decoder.decode(plain)));
  if (record.id !== row.id) throw unavailable();
  return record;
}
function open() {
  return new Promise((resolve, reject) => {
    let rejected = false;
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'slot' }); };
    request.onerror = request.onblocked = () => { rejected = true; reject(unavailable()); };
    request.onsuccess = () => { if (rejected) request.result.close(); else resolve(request.result); };
  });
}

export class PendingStore {
  #now;
  #closed = false;
  #forgotten = new Set();
  #writes = new Map();
  #observed = new Map();
  constructor(now = Date.now) {
    if (typeof now !== 'function') throw unavailable();
    // Persist server deadlines unchanged. The caller supplies its current server clock.
    this.#now = () => { const value = now(); if (!Number.isFinite(value)) throw unavailable(); return value; };
  }
  #active(secret) { return !this.#closed && !this.#forgotten.has(secret); }
  #require(secret) { if (!this.#active(secret)) throw unavailable(); }
  async #transaction(mode, operation, secret) {
    const db = await open();
    try {
      if (secret !== undefined) this.#require(secret);
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode), store = tx.objectStore(STORE);
        let result, failure;
        if (secret !== undefined && mode === 'readwrite') this.#writes.set(tx, secret);
        const fail = error => { failure = error; try { tx.abort(); } catch { /* Already aborted. */ } };
        tx.oncomplete = () => { this.#writes.delete(tx); resolve(result); };
        tx.onerror = tx.onabort = () => { this.#writes.delete(tx); reject(failure ?? unavailable()); };
        try { operation(store, value => { result = value; }, fail); } catch (error) { fail(error); }
      });
    } finally { db.close(); }
  }
  #get(slot, secret) {
    return this.#transaction('readonly', (store, done) => { const request = store.get(slot); request.onsuccess = () => done(request.result); }, secret);
  }
  #discard(slot, expected) {
    // Conditional deletion cannot erase a new intent written by another tab.
    return this.#transaction('readwrite', store => {
      const request = store.get(slot);
      request.onsuccess = () => {
        const current = request.result;
        if (current && (sameRow(current, expected) || (!envelope(current, slot) && !envelope(expected, slot)))) store.delete(slot);
      };
    });
  }
  async save(rawSecret, input, expiresAt) {
    try {
      const secret = secretValue(rawSecret); this.#require(secret);
      const record = recordValue(input), serialized = JSON.stringify(record);
      if (!Number.isSafeInteger(expiresAt) || expiresAt <= this.#now()) throw unavailable();
      const { slot, key } = await material(secret); this.#require(secret);
      const row = { slot, id: record.id, iv: crypto.getRandomValues(new Uint8Array(12)), expiresAt };
      row.ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: row.iv, additionalData: aad(row) }, key, encoder.encode(serialized));
      this.#require(secret);
      for (let attempt = 0; attempt < 8; attempt++) {
        const prior = await this.#get(slot, secret); this.#require(secret);
        if (prior) this.#observed.set(secret, prior);
        if (prior && prior.expiresAt > this.#now()) {
          if (prior.id !== record.id) throw new Error('pending_storage_busy');
          let previous;
          try { previous = await decrypt(prior, slot, key, this.#now()); } catch { await this.#discard(slot, prior); throw unavailable(); }
          this.#require(secret);
          if (JSON.stringify(previous) !== serialized) throw new Error('pending_storage_conflict');
        }
        const outcome = await this.#transaction('readwrite', (store, done, fail) => {
          const request = store.getAll();
          request.onsuccess = () => {
            try {
              this.#require(secret);
              const now = this.#now();
              if (expiresAt <= now) throw unavailable();
              const live = request.result.filter(item => {
                if (!Number.isSafeInteger(item.expiresAt) || item.expiresAt <= now) { store.delete(item.slot); return false; }
                return true;
              });
              const current = live.find(item => item.slot === slot);
              if (current) {
                if (current.id !== record.id) throw new Error('pending_storage_busy');
                done(sameRow(current, prior) ? { saved: current } : {}); return;
              }
              if (live.length >= 100) throw unavailable();
              store.put(row); done({ saved: row });
            } catch (error) { fail(error); }
          };
        }, secret);
        if (outcome.saved) {
          // A commit can finish immediately before forget() marks this instance.
          // Delete only that exact row, never a replacement from another tab.
          if (this.#forgotten.has(secret)) await this.#discard(slot, outcome.saved);
          else this.#observed.set(secret, outcome.saved);
        }
        this.#require(secret);
        if (outcome.saved) return;
      }
      throw new Error('pending_storage_busy');
    } catch (error) {
      if (['pending_storage_busy', 'pending_storage_conflict'].includes(error?.message)) throw error;
      throw unavailable();
    }
  }
  async load(rawSecret) {
    try {
      const secret = secretValue(rawSecret); if (!this.#active(secret)) return null;
      const { slot, key } = await material(secret); if (!this.#active(secret)) return null;
      const row = await this.#get(slot, secret); if (!row) return null;
      if (!this.#active(secret)) return null;
      this.#observed.set(secret, row);
      let record;
      try { record = await decrypt(row, slot, key, this.#now()); }
      catch { await this.#discard(slot, row); return null; }
      if (!this.#active(secret)) return null;
      if (row.expiresAt <= this.#now()) { await this.#discard(slot, row); return null; }
      return record;
    } catch { throw unavailable(); }
  }
  async remove(rawSecret, id) {
    try {
      const secret = secretValue(rawSecret), { slot } = await material(secret);
      await this.#transaction('readwrite', store => {
        const request = store.get(slot);
        request.onsuccess = () => { if (request.result && (id === undefined || request.result.id === id)) store.delete(slot); };
      });
    } catch { throw unavailable(); }
  }
  async forget(rawSecret) {
    const secret = secretValue(rawSecret);
    this.#forgotten.add(secret);
    const observed = this.#observed.get(secret); this.#observed.delete(secret);
    for (const [tx, owner] of this.#writes) if (owner === secret) { try { tx.abort(); } catch { /* Already completed. */ } }
    // Cleanup intentionally survives close(), which callers invoke immediately on logout.
    if (observed) await this.#discard(observed.slot, observed);
  }
  close() {
    this.#closed = true;
    for (const tx of this.#writes.keys()) { try { tx.abort(); } catch { /* Already completed. */ } }
  }
}
