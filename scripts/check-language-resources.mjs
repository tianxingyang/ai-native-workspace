import { catalogs, fallbackId } from '../web/locales/registry.js';
import { createLanguageRegistry } from '../web/presentation.js';
import { readDesktopResources } from './desktop-resources.mjs';

const shared = createLanguageRegistry(catalogs, fallbackId);
const { locale } = await readDesktopResources(new URL('../', import.meta.url));
// The bridge locks by ID, so the selected native locale must have the same
// registered shared ID and formatting locale. No automatic language negotiation.
const choice = shared.choices.find(choice => choice.id === locale);
if (!choice || choice.locale !== locale) throw new Error('Selected desktop language must match a bundled shared catalog and its formatting locale');
console.log('Shared and compiled desktop language registrations agree.');
