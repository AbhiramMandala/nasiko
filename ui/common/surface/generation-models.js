/**
 * The models a person may generate a surface with, and which one they chose.
 *
 * One list, read from `generation-models.json`, shared by the Weave dock and
 * the Weave page, so both offer the same models and remember the same choice.
 * The same file is what the EE Weave surface holds its allowlist
 * to, so a model offered here is a model the route accepts.
 *
 * What travels on the request is a KEY (`"haiku"`, `"sonnet"`), never a model
 * id. The route refuses a key it does not list and the generator maps the key
 * to the model it actually calls — a page cannot name an arbitrary model by
 * asking, and neither can anything that edits this file in a browser.
 *
 * Failure is quiet on purpose. If the list cannot load, the picker stays
 * hidden and requests carry no key, which the route treats as its default —
 * the person generates with the default model rather than not at all.
 */

const STORAGE_KEY = 'weave-model';

/** @typedef {{key: string, label: string, description?: string}} GenerationModel */
/** @typedef {{default: string, models: GenerationModel[]}} GenerationModels */

let listPromise = null;

/**
 * Loaded once per page and shared.
 *
 * @returns {Promise<GenerationModels|null>} null when unavailable or malformed
 */
export function loadGenerationModels() {
  listPromise ??= fetch(new URL('/common/surface/generation-models.json', globalThis.document?.baseURI))
    .then((res) => {
      if (!res.ok) throw new Error(`generation-models.json: ${res.status}`);
      return res.json();
    })
    .then(checkedModels)
    .catch(() => null);
  return listPromise;
}

/**
 * Only what a picker can use. A list whose default is not one of its own
 * models is not a list to guess around — it is a broken file, and offering it
 * would send a key the route may not accept.
 *
 * @param {any} raw
 * @returns {GenerationModels|null}
 */
export function checkedModels(raw) {
  const models = Array.isArray(raw?.models)
    ? raw.models.filter((m) => typeof m?.key === 'string' && m.key && typeof m?.label === 'string')
    : [];
  if (!models.length || !models.some((m) => m.key === raw.default)) return null;
  return { default: raw.default, models };
}

/**
 * The key to preselect: the person's last choice while it is still offered,
 * otherwise the default. A remembered key the list no longer carries falls
 * back rather than sticking, so removing a model cannot strand anyone on it.
 *
 * @param {GenerationModels|null} list
 * @param {Storage|undefined} [store]
 * @returns {string|null}
 */
export function chosenModel(list, store = globalThis.localStorage) {
  if (!list) return null;
  let remembered = null;
  try { remembered = store?.getItem(STORAGE_KEY) ?? null; } catch { /* private mode */ }
  return list.models.some((m) => m.key === remembered) ? remembered : list.default;
}

/**
 * @param {string} key
 * @param {Storage|undefined} [store]
 */
export function rememberModel(key, store = globalThis.localStorage) {
  try { store?.setItem(STORAGE_KEY, key); } catch { /* private mode */ }
}

/**
 * @param {GenerationModels|null} list
 * @param {string|null|undefined} key
 * @returns {string|null}
 */
export function modelLabel(list, key) {
  return list?.models.find((m) => m.key === key)?.label ?? null;
}

/**
 * The `options` attribute `<app-select>` takes. Built here, not per host, so
 * the dock and the page cannot render the same list two ways.
 *
 * @param {GenerationModels} list
 * @returns {string}
 */
export function modelOptions(list) {
  return JSON.stringify(list.models.map((m) => ({ value: m.key, label: m.label })));
}
