import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const RESOURCE_KEYS = ['menu_show', 'menu_quit', 'window_title', 'notification_title', 'notification_body', 'short_description'];
const identifier = value => typeof value === 'string' && value.length <= 64 && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/i.test(value);

/** Explicit bundled demo registration only. No user-supplied paths, locale guessing or downloads. */
export function validateDesktopManifest(manifest) {
  if (manifest?.schemaVersion !== 1 || manifest.mode !== 'demo') throw new Error('Expected version 1 demo desktop manifest');
  if (!Array.isArray(manifest.catalogs)) throw new Error('Expected registered desktop catalogs');
  const seen = new Set();
  for (const entry of manifest.catalogs) {
    if (!identifier(entry?.locale) || typeof entry.file !== 'string' || !entry.file.endsWith('.json')
        || !identifier(entry.file.slice(0, -5)) || seen.has(entry.locale)) throw new Error('Invalid or duplicate registered desktop catalog');
    seen.add(entry.locale);
  }
  if (!seen.has(manifest.selected) || !seen.has(manifest.fallback)) throw new Error('Selected and fallback desktop locales must be registered');
  return manifest;
}

export function resolveDesktopResources(manifest, catalogs) {
  validateDesktopManifest(manifest);
  for (const { locale } of manifest.catalogs) {
    const catalog = Object.hasOwn(catalogs, locale) && catalogs[locale];
    if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) throw new Error(`Missing desktop catalog: ${locale}`);
    for (const [key, value] of Object.entries(catalog)) {
      if (!RESOURCE_KEYS.includes(key) || typeof value !== 'string' || !value.trim()) throw new Error(`Invalid desktop resource: ${locale}.${key}`);
    }
  }
  const selected = catalogs[manifest.selected], fallback = catalogs[manifest.fallback];
  return Object.fromEntries(RESOURCE_KEYS.map(key => {
    if (!Object.hasOwn(fallback, key)) throw new Error(`Missing fallback desktop resource: ${key}`);
    return [key, Object.hasOwn(selected, key) ? selected[key] : fallback[key]];
  }));
}

export async function readDesktopResources(root) {
  const manifest = validateDesktopManifest(JSON.parse(await readFile(new URL('src-tauri/locales/manifest.json', root), 'utf8')));
  const catalogs = Object.fromEntries(await Promise.all(manifest.catalogs.map(async ({ locale, file }) =>
    [locale, JSON.parse(await readFile(new URL(`src-tauri/locales/${file}`, root), 'utf8'))])));
  return { locale: manifest.selected, catalog: resolveDesktopResources(manifest, catalogs) };
}

/** Only these two Tauri fields are derived. Product identity and NSIS settings stay independent. */
export function synchronizeDesktopResources(config, catalog) {
  for (const key of RESOURCE_KEYS) {
    if (typeof catalog[key] !== 'string' || !catalog[key].trim()) throw new Error(`Missing desktop resource: ${key}`);
  }
  const next = structuredClone(config);
  const mainWindows = next.app?.windows?.filter(window => window.label === 'main') ?? [];
  if (mainWindows.length !== 1) throw new Error('Expected exactly one main window');
  if (!next.bundle || typeof next.bundle !== 'object' || Array.isArray(next.bundle)) throw new Error('Expected bundle configuration');
  const changed = [];
  if (mainWindows[0].title !== catalog.window_title) changed.push('app.windows[main].title');
  if (next.bundle.shortDescription !== catalog.short_description) changed.push('bundle.shortDescription');
  mainWindows[0].title = catalog.window_title;
  next.bundle.shortDescription = catalog.short_description;
  return { config: next, changed };
}

export async function updateDesktopResources(root, { check = true } = {}) {
  const configPath = new URL('src-tauri/tauri.conf.json', root);
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const { catalog } = await readDesktopResources(root);
  const result = synchronizeDesktopResources(config, catalog);
  if (result.changed.length) {
    if (check) throw new Error(`Stale desktop resources: ${result.changed.join(', ')}. Run npm run desktop:resources.`);
    await writeFile(configPath, `${JSON.stringify(result.config, null, 2)}\n`);
  }
  return result.changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['--check', '--write'].includes(args[0])) {
    console.error('Usage: node scripts/desktop-resources.mjs --check|--write');
    process.exitCode = 1;
  } else {
    try {
      const changed = await updateDesktopResources(new URL('../', import.meta.url), { check: args[0] === '--check' });
      console.log(changed.length ? `Updated desktop resources: ${changed.join(', ')}` : 'Desktop resources match the existing demo catalog.');
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
