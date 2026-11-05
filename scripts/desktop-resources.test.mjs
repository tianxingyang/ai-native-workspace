import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { synchronizeDesktopResources, updateDesktopResources, validateDesktopManifest, resolveDesktopResources, readDesktopResources } from './desktop-resources.mjs';

const root = new URL('../', import.meta.url);
const config = JSON.parse(await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
const catalog = JSON.parse(await readFile(new URL('src-tauri/locales/zh-CN.json', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('src-tauri/locales/manifest.json', root), 'utf8'));

test('checked-in desktop configuration matches the catalog without rewriting files', async () => {
  const before = await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8');
  assert.deepEqual(await updateDesktopResources(root), []);
  assert.equal(await readFile(new URL('src-tauri/tauri.conf.json', root), 'utf8'), before);
  // The CLI resolves paths relative to its script, not the calling directory.
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('desktop-resources.mjs', import.meta.url)), '--check'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(await readDesktopResources(root), { locale: manifest.selected, catalog });
});

test('resource changes update only the named main window and installer description', () => {
  const input = structuredClone(config);
  input.app.windows.unshift({ label: 'secondary', title: 'Keep this title' });
  const before = structuredClone(input);
  const resource = { ...catalog, window_title: 'Demo "quoted" \\ title\n<&> 中文', short_description: 'Demo\t<&> description' };
  const result = synchronizeDesktopResources(input, resource);
  assert.deepEqual(result.changed, ['app.windows[main].title', 'bundle.shortDescription']);
  assert.equal(result.config.app.windows[1].title, resource.window_title);
  assert.equal(result.config.bundle.shortDescription, resource.short_description);
  const expected = structuredClone(before);
  expected.app.windows[1].title = resource.window_title;
  expected.bundle.shortDescription = resource.short_description;
  assert.deepEqual(result.config, expected);
  assert.deepEqual(input, before);
  assert.deepEqual(synchronizeDesktopResources(result.config, resource).changed, []);
});

test('invalid resources and ambiguous main windows fail before producing a config', () => {
  for (const key of Object.keys(catalog)) {
    for (const invalid of [undefined, null, 42, '', '   ']) {
      assert.throws(() => synchronizeDesktopResources(config, { ...catalog, [key]: invalid }), /Missing desktop resource/);
    }
  }
  for (const windows of [[], [{ label: 'other' }], [{ label: 'main' }, { label: 'main' }]]) {
    assert.throws(() => synchronizeDesktopResources({ ...config, app: { windows } }, catalog), /exactly one main window/);
  }
});

test('check detects each stale field without writes; explicit generation is deterministic', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coseat-desktop-resources-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = pathToFileURL(directory + sep);
  await mkdir(new URL('src-tauri/locales/', fixture), { recursive: true });
  await writeFile(new URL('src-tauri/locales/zh-CN.json', fixture), JSON.stringify(catalog));
  await writeFile(new URL('src-tauri/locales/manifest.json', fixture), JSON.stringify(manifest));
  const configPath = new URL('src-tauri/tauri.conf.json', fixture);
  for (const field of ['title', 'shortDescription']) {
    const stale = structuredClone(config);
    if (field === 'title') stale.app.windows[0].title = 'stale';
    else stale.bundle.shortDescription = 'stale';
    const before = JSON.stringify(stale);
    await writeFile(configPath, before);
    await assert.rejects(updateDesktopResources(fixture), /Stale desktop resources/);
    assert.equal(await readFile(configPath, 'utf8'), before);
    assert.equal((await updateDesktopResources(fixture, { check: false })).length, 1);
    const generated = await readFile(configPath, 'utf8');
    assert.deepEqual(JSON.parse(generated), config);
    assert.deepEqual(await updateDesktopResources(fixture, { check: false }), []);
    assert.equal(await readFile(configPath, 'utf8'), generated);
    assert.deepEqual(await updateDesktopResources(fixture), []);
  }
});

test('registered desktop selection and missing-key fallback preserve literal text', () => {
  const fixture = { schemaVersion: 1, mode: 'demo', selected: 'test-XA', fallback: 'test-XB', catalogs: [
    { locale: 'test-XA', file: 'test-XA.json' }, { locale: 'test-XB', file: 'test-XB.json' },
  ] };
  const catalogs = { 'test-XA': { window_title: 'Synthetic "title" \\ <&>\n', short_description: 'Synthetic package' }, 'test-XB': catalog };
  const resolved = resolveDesktopResources(fixture, catalogs);
  assert.equal(resolved.window_title, catalogs['test-XA'].window_title);
  assert.equal(resolved.notification_body, catalog.notification_body);
  assert.equal(resolved.short_description, catalogs['test-XA'].short_description);
  assert.equal(Object.hasOwn(catalogs['test-XA'], 'notification_body'), false);
  for (const invalid of [null, '', '   ', 12]) {
    assert.throws(() => resolveDesktopResources(fixture, { ...catalogs, 'test-XA': { window_title: invalid } }), /Invalid desktop resource/);
  }
  const incomplete = { ...catalog }; delete incomplete.window_title;
  assert.throws(() => resolveDesktopResources(fixture, { ...catalogs, 'test-XB': incomplete }), /Missing fallback desktop resource/);
});

test('desktop registry rejects unknown selections, duplicates and nonlocal catalog paths', () => {
  for (const field of ['selected', 'fallback']) {
    assert.throws(() => validateDesktopManifest({ ...manifest, [field]: 'unregistered' }), /must be registered/);
  }
  for (const file of ['../outside.json', '/absolute.json', 'C:\\secret.json', 'https://example.com/catalog.json', 'zh-CN.json?x']) {
    assert.throws(() => validateDesktopManifest({ ...manifest, catalogs: [{ locale: 'zh-CN', file }] }), /Invalid or duplicate/);
  }
  assert.throws(() => validateDesktopManifest({ ...manifest, catalogs: [...manifest.catalogs, ...manifest.catalogs] }), /Invalid or duplicate/);
  assert.throws(() => validateDesktopManifest({ ...manifest, mode: 'product-default' }), /demo desktop manifest/);
  assert.throws(() => resolveDesktopResources(manifest, { 'zh-CN': { ...catalog, typo: 'oops' } }), /Invalid desktop resource/);
});
