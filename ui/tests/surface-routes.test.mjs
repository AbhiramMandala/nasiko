/**
 * The route allowlist — the only place a generated surface can send someone.
 *
 * The check runs against the live router rather than a generated copy, so
 * these tests build a real Router and register real routes. A copy would be a
 * second source of truth about what the app can do, which is the failure this
 * codebase has already paid for twice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Router } from '../common/core/router.js';
import { render } from '../common/surface/render.js';
import { createActionRunner } from '../common/surface/actions.js';

const catalog = JSON.parse(readFileSync(new URL('../common/surface/dsl-catalog.json', import.meta.url), 'utf8'));

function routerWith(...paths) {
  const r = new Router();
  for (const p of paths) r.add(p, { tag: 'x-page', module: '/x.js' });
  return r;
}

function recorder() {
  const make = (tag) => ({
    tag, attrs: {}, children: [], listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    replaceChildren() { this.children.length = 0; },
  });
  return { doc: { createElement: make }, container: make('div') };
}

// ── router.has ──────────────────────────────────────────────────────────────

test('a registered path is allowed', () => {
  assert.equal(routerWith('/agents', '/tokenops').has('/agents'), true);
});

test('an unregistered path is not', () => {
  assert.equal(routerWith('/agents').has('/secrets'), false);
});

test('a :param pattern matches a concrete path', () => {
  assert.equal(routerWith('/agent/:id').has('/agent/a-001'), true);
  assert.equal(routerWith('/agent/:id').has('/agent/a-001/keys'), false);
});

test('an off-site URL is refused before it reaches the route table', () => {
  const r = routerWith('/agents');
  for (const hostile of [
    'https://evil.test/agents',
    '//evil.test/agents',
    'javascript:alert(1)',
    'data:text/html,<script>',
    'agents',
  ]) {
    assert.equal(r.has(hostile), false, `${hostile} must not be navigable`);
  }
});

test('traversal is refused', () => {
  assert.equal(routerWith('/agents').has('/agents/../../etc/passwd'), false);
});

test('a control character is refused', () => {
  assert.equal(routerWith('/agents').has('/agents\n/x'), false);
});

test('a query string does not change which route matched', () => {
  assert.equal(routerWith('/agents').has('/agents?q=hi'), true);
});

test('empty and non-string inputs are refused rather than throwing', () => {
  const r = routerWith('/agents');
  for (const bad of ['', null, undefined, 42, {}]) assert.equal(r.has(bad), false);
});

// ── the renderer ────────────────────────────────────────────────────────────

const cardNode = (href) => ({
  type: 'element', tag: 'app-card', statementId: 'c',
  props: { name: 'coding-agent', href }, children: [],
});

test('an allowed href is set on the element', () => {
  const { doc, container } = recorder();
  render(cardNode('/agents'), container, catalog, { doc, routes: routerWith('/agents') });
  assert.equal(container.children[0].attrs.href, '/agents');
});

test('a route the app does not have is dropped, and named in the diagnostic', () => {
  const diagnostics = [];
  const { doc, container } = recorder();
  render(cardNode('/nope'), container, catalog, {
    doc, routes: routerWith('/agents'), onDiagnostic: (d) => diagnostics.push(d),
  });
  assert.equal(container.children[0].hasAttribute('href'), false, 'a link to the wrong place is worse than no link');
  const d = diagnostics.find((x) => x.code === 'route_not_allowed');
  assert.ok(d);
  assert.match(d.message, /\/nope/);
});

test('a host that wires no router refuses every route', () => {
  const diagnostics = [];
  const { doc, container } = recorder();
  render(cardNode('/agents'), container, catalog, { doc, onDiagnostic: (d) => diagnostics.push(d) });
  assert.equal(container.children[0].hasAttribute('href'), false, 'the default has to be closed, not open');
  assert.ok(diagnostics.some((d) => d.code === 'route_not_allowed'));
});

// ── @OpenUrl ────────────────────────────────────────────────────────────────

function runner({ routes, navigate, diagnostics = [] }) {
  return {
    diagnostics,
    run: createActionRunner({
      store: { set: () => false, reset: () => false },
      queries: { isQuery: () => false, isMutation: () => false, run: async () => ({ ok: true }), fireMutation: async () => ({ ok: true }) },
      refresh: () => ({ evaluateAst: (n) => (n?.k === 'Str' ? n.v : null) }),
      onDiagnostic: (d) => diagnostics.push(d),
      routes, navigate,
    }).run,
  };
}

const openUrl = (path) => ({
  type: 'action', statementId: 'go',
  steps: [{ kind: 'openUrl', urlAst: { k: 'Str', v: path }, scope: null }],
});

test('@OpenUrl follows an allowed route', async () => {
  const went = [];
  const r = runner({ routes: routerWith('/tokenops'), navigate: (p) => went.push(p) });
  await r.run(openUrl('/tokenops'), (n) => (n?.k === 'Str' ? n.v : null));
  assert.deepEqual(went, ['/tokenops']);
});

test('@OpenUrl to somewhere the app has no route for goes nowhere', async () => {
  const went = [];
  const r = runner({ routes: routerWith('/tokenops'), navigate: (p) => went.push(p) });
  await r.run(openUrl('https://evil.test'), (n) => (n?.k === 'Str' ? n.v : null));
  assert.deepEqual(went, []);
  assert.ok(r.diagnostics.some((d) => d.code === 'route_not_allowed'));
});

test('an allowed route with no navigator wired is reported, not silently dropped', async () => {
  const r = runner({ routes: routerWith('/tokenops'), navigate: undefined });
  await r.run(openUrl('/tokenops'), (n) => (n?.k === 'Str' ? n.v : null));
  assert.ok(r.diagnostics.some((d) => d.code === 'no_navigator'));
});

// ── the catalog's own route list ────────────────────────────────────────────

test('the catalog ships the routes the app registers, minus parameterised ones', () => {
  assert.ok(catalog.routes.length > 10);
  assert.ok(catalog.routes.includes('/tokenops'));
  assert.equal(catalog.routes.some((p) => p.includes(':')), false,
    'a model cannot know a real id, so every link built from one would 404');
  assert.deepEqual(catalog.routes, [...catalog.routes].sort(), 'sorted, so a diff is readable');
});
