import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

/** Only these two Tauri fields are derived. Product identity and NSIS settings stay independent. */
export function synchronizeDesktopResources(config, catalog) {
  for (const key of ['menu_show', 'menu_quit', 'window_title', 'notification_title', 'notification_body', 'short_description']) {
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
  const catalog = JSON.parse(await readFile(new URL('src-tauri/locales/zh-CN.json', root), 'utf8'));
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
