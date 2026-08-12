/**
 * Typed cross-domain event contracts.
 *
 * The architecture note this implements: cross-domain communication should be a
 * *typed application event bus* carrying notifications — `AgentCreated`,
 * `UserLoggedIn`, `ThemeChanged`, `WorkspaceChanged` — and it must not become a
 * giant hidden state-management system. Events are for "this happened", not a
 * replacement for every API call.
 *
 * So this module is deliberately small and deliberately closed: the event names
 * are an enumerated contract, not a free-form string channel. Publishing an
 * unknown name throws in dev. That is the difference between an event bus and a
 * `window`-shaped free-for-all — the same distinction that made ~107 untyped
 * `window.fetch*` globals hard to reason about.
 *
 * Layering rule (never violate): a Design-System primitive must not import this.
 * Only domain modules, the shell, and pages publish or subscribe. A `<app-button>`
 * that knows about `AgentCreated` has coupled the bottom layer to the top.
 */

import { invalidate } from '../state/store.js';
import { violation } from './env.js';

/**
 * The contract. Each entry documents its payload and which cache keys it
 * invalidates, so a publisher does not have to remember to call `invalidate`
 * separately — the two were previously unrelated and drifted.
 *
 * @type {Record<string, { payload: string, invalidates?: string[] }>}
 */
export const EVENTS = Object.freeze({
  'user:signed-in': { payload: '{ userId }', invalidates: ['currentUser', 'navTree'] },
  'user:signed-out': { payload: '{}', invalidates: ['currentUser', 'navTree'] },
  'user:updated': { payload: '{ userId }', invalidates: ['currentUser'] },
  'workspace:changed': { payload: '{ workspaceId }', invalidates: ['*'] },
  'theme:changed': { payload: '{ theme: "light"|"dark"|"system" }' },

  'agent:created': { payload: '{ agentId, name }', invalidates: ['agents'] },
  'agent:updated': { payload: '{ agentId }', invalidates: ['agents'] },
  'agent:deleted': { payload: '{ agentId }', invalidates: ['agents'] },
  'agent:status-changed': { payload: '{ agentId, status }', invalidates: ['agents'] },

  'build:started': { payload: '{ buildId, agentId }', invalidates: ['builds'] },
  'build:finished': { payload: '{ buildId, agentId, status }', invalidates: ['builds', 'agents'] },

  'session:created': { payload: '{ sessionId }', invalidates: ['sessions'] },
  'session:deleted': { payload: '{ sessionId }', invalidates: ['sessions'] },

  'workflow:created': { payload: '{ workflowId }', invalidates: ['workflows'] },
  'workflow:run-started': { payload: '{ workflowId, executionId }', invalidates: ['executions'] },
  'workflow:run-finished': {
    payload: '{ workflowId, executionId, status }',
    invalidates: ['executions', 'workflows'],
  },

  'connector:changed': { payload: '{ connectorId }', invalidates: ['connectors'] },
  'secret:changed': { payload: '{ scope, name }', invalidates: ['secrets'] },

  'org:membership-changed': {
    payload: '{ userId }',
    invalidates: ['orgUsers', 'teams', 'departments'],
  },
});

const target = new EventTarget();

function assertKnown(name) {
  if (name in EVENTS) return;
  violation(
    `Unknown application event "${name}". Add it to EVENTS in /common/core/events.js ` +
      `with its payload shape and the cache keys it invalidates. ` +
      `Known: ${Object.keys(EVENTS).join(', ')}`,
  );
}

/**
 * Announce that something happened. Also performs the cache invalidation the
 * contract declares, so a publisher cannot update one and forget the other.
 *
 * ```js
 * await api.post('/agents', body);
 * publish('agent:created', { agentId: created.id, name: created.name });
 * ```
 *
 * @param {keyof typeof EVENTS} name
 * @param {object} [payload]
 */
export function publish(name, payload = {}) {
  assertKnown(name);
  for (const key of EVENTS[name]?.invalidates || []) invalidate(key);
  target.dispatchEvent(new CustomEvent(name, { detail: payload }));
}

/**
 * Subscribe. Returns a disposer — in a component, prefer
 * `this.onTeardown(subscribe(...))` or `NasikoElement#listen`.
 *
 * @param {keyof typeof EVENTS} name
 * @param {(payload: any) => void} handler
 * @returns {() => void}
 */
export function subscribe(name, handler) {
  assertKnown(name);
  const wrapped = (e) => handler(/** @type {CustomEvent} */ (e).detail);
  target.addEventListener(name, wrapped);
  return () => target.removeEventListener(name, wrapped);
}

/** The injectable surface, for components that receive an event bus. */
export const events = Object.freeze({ publish, subscribe, EVENTS });
