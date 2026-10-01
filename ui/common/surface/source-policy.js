/**
 * Generated DSL may call only the approved read inventory, never any arbitrary
 * function in the app-wide registry (which also contains writes). The generator
 * has the narrower server-selected scope. The browser retains the historical
 * TokenOps read inventory so saved surfaces from all three scopes still work.
 */
import { call } from '../core/data-sources.js';
import { loadDataManifest } from './catalog-load.js';

export async function callSurfaceSource(name, ...args) {
  return callReadSource(await loadDataManifest(), call, name, args);
}

export function callReadSource(manifest, invoke, name, args) {
  const sources = manifest?.scopes?.tokenops;
  if (!Array.isArray(sources) || !sources.some(source => source.name === name)) {
    const error = new Error(`Data source "${name}" is not approved for generated surfaces`);
    error.code = 'source_not_allowed';
    throw error;
  }
  return invoke(name, ...args);
}
