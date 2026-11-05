import assert from 'node:assert/strict';
import test from 'node:test';
import { createLanguageRegistry } from '../web/presentation.js';

const base = { locale: 'zh-CN', messages: { shared: '你好 {name}', missing: '原始回退 {count}' }, formats: { day: { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' } } };
const synthetic = { locale: 'en-GB', messages: { shared: 'Synthetic {name}' }, formats: {} };
const entries = () => [{ id: 'demo', label: 'Existing demo', catalog: structuredClone(base) }, { id: 'synthetic', label: 'Test-only', catalog: structuredClone(synthetic) }];

test('explicit selection keeps imported functions live and missing keys/formats fall back', () => {
  const registry = createLanguageRegistry(entries(), 'demo'), text = registry.text, format = registry.format;
  let changes = 0; const unsubscribe = registry.subscribe(() => changes++);
  assert.equal(registry.select('synthetic'), true);
  assert.equal(text('shared', { name: '<img>{count}' }), 'Synthetic <img>{count}');
  assert.equal(text('missing', { count: 0 }), '原始回退 0');
  assert.equal(registry.messageLocale('missing'), 'zh-CN');
  assert.equal(format('day', Date.UTC(2026, 10, 5)), '05/11/2026');
  assert.equal(registry.select('synthetic'), false); assert.equal(changes, 1);
  unsubscribe(); registry.select('demo'); assert.equal(changes, 1);
  assert.equal(text('shared', { name: '保持正文' }), '你好 保持正文');
});

test('unrecognized saved selection uses explicit fallback; direct unknown selection is rejected', () => {
  const registry = createLanguageRegistry(entries(), 'demo', '../../remote');
  assert.equal(registry.id, 'demo');
  for (const id of ['toString', 'https://example.test/a.js', '../x', 'en-US', undefined]) assert.throws(() => registry.select(id), /Unregistered/);
  assert.equal(registry.id, 'demo');
  assert.throws(() => registry.text('toString'), /Unknown/);
});

test('catalogs are snapshotted and malformed translations cannot replace parameter contracts', () => {
  const input = entries(), registry = createLanguageRegistry(input, 'demo');
  input[0].catalog.messages.shared = 'mutated';
  assert.equal(registry.text('shared', { name: 'x' }), '你好 x');
  for (const value of ['', null, 3, 'Lost parameter', '{other}']) {
    const bad = entries(); bad[1].catalog.messages.shared = value;
    assert.throws(() => createLanguageRegistry(bad, 'demo'), /Invalid|Mismatched/);
  }
  assert.throws(() => createLanguageRegistry([...entries(), entries()[0]], 'demo'), /registration/);
  assert.throws(() => createLanguageRegistry(entries(), 'absent'), /fallback/);
});

test('desktop lock selects the compiled catalog and disallows runtime disagreement', () => {
  const registry = createLanguageRegistry(entries(), 'demo');
  registry.lock('synthetic'); assert.equal(registry.id, 'synthetic'); assert.equal(registry.locked, 'synthetic');
  assert.throws(() => registry.select('demo'), /rebuild/);
  assert.throws(() => registry.lock('demo'), /locked/);
  assert.equal(registry.id, 'synthetic');
});
