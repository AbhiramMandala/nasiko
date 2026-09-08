/**
 * Human-in-the-loop wiring: the two places a mistake is silent.
 *
 *  1. The `hitl` data part must leave the stream as the turn's *outcome*, not
 *     as a step. Routed to `onData` instead, it would land in the activity
 *     timeline as an unknown event — silently dropped — and the page would
 *     render "No response" for a turn that is actually waiting on a human.
 *  2. A reconnect must carry `reconnect_after_hitl_id` and nothing else. With
 *     an agent_id or a session_id alongside it the server treats the call as a
 *     new turn, which calls the agent a second time.
 *
 * Plus the two pure helpers that shape what the card shows.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installBrowserShim } from './browser-shim.mjs';

installBrowserShim();

const { readA2aStream } = await import(new URL('../common/utils/a2a-stream.js', import.meta.url).href);
const { connectorFor, detailRows, pendingRows, toolLabel } = await import(
  new URL('../common/services/hitl.js', import.meta.url).href);

function sse(frames) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(enc.encode(`data: ${JSON.stringify(f)}\n\n`));
      controller.close();
    },
  }));
}

/** The frame the server yields once the row is durably committed (§11.2). */
const hitlFrame = (row) => ({
  statusUpdate: {
    taskId: 't1',
    contextId: 'ses_1',
    status: { state: 'TASK_STATE_WORKING', message: { parts: [{ data: { type: 'hitl', ...row } }] } },
  },
});

test('a hitl part is the turn outcome, not an activity step', async () => {
  const row = { id: 'h1', kind: 'tool_approval', question: { tool_name: 'LINEAR_GET_PROJECT' } };
  const steps = [];
  const paused = [];
  const out = await readA2aStream(sse([hitlFrame(row)]), {
    onData: (d) => steps.push(d),
    onHitl: (r) => paused.push(r),
  });

  assert.deepEqual(steps, [], 'must not reach the activity timeline');
  assert.equal(paused.length, 1);
  assert.equal(out.hitl.id, 'h1');
  assert.equal(out.text, '', 'a pause carries no reply');
});

test('a turn that replies leaves hitl null', async () => {
  const out = await readA2aStream(
    sse([{ artifactUpdate: { artifact: { parts: [{ text: 'done' }] }, lastChunk: true } }]), {});
  assert.equal(out.hitl, null);
  assert.equal(out.text, 'done');
});

test('a hitl part with no id is not treated as a pause', async () => {
  // Defensive: resolving needs an id, and a card with nothing to resolve would
  // block the composer forever.
  const out = await readA2aStream(sse([hitlFrame({ kind: 'input_required' })]), {});
  assert.equal(out.hitl, null);
});

test('reconnect sends only reconnect_after_hitl_id', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response('', { status: 200 });
  };
  const { reconnectAfterHitl } = await import(
    new URL('../common/services/hitl.js', import.meta.url).href);
  await reconnectAfterHitl('h1');

  const [call] = calls;
  assert.match(call.url, /\/api\/orchestrator\/a2a$/);
  assert.equal(call.body.method, 'message/stream');
  assert.deepEqual(call.body.params.metadata, { reconnect_after_hitl_id: 'h1' });
  assert.deepEqual(call.body.params.message.parts, [], 'a reconnect carries no new message');
  assert.equal(call.body.params.message.agentId, undefined);
  assert.equal(call.body.params.message.contextId, undefined);
});

test('tool slug reads as a sentence, without repeating the connector', () => {
  assert.equal(toolLabel('LINEAR_GET_PROJECT', 'Linear'), 'Get project from Linear');
  assert.equal(toolLabel('GITHUB_CREATE_AN_ISSUE', 'GitHub'), 'Create an issue from GitHub');
  // No connector known: still readable, and the slug is not mistaken for one.
  assert.equal(toolLabel('GET_PROJECT', null), 'Get project');
  // A one-word slug that happens to match the connector keeps its only word.
  assert.equal(toolLabel('LINEAR', 'Linear'), 'Linear from Linear');
  assert.equal(toolLabel(null, 'Linear'), 'Linear');
});

test('the connector comes from the question before the connector list', () => {
  const listed = new Map([['c1', { name: 'Stale name', logo_url: '/stale.png' }]]);

  // tool_approval's own display name + logo win, and cost no request.
  assert.deepEqual(
    connectorFor({ connector_id: 'c1', connector_name: 'GitHub', connector_logo_url: '/gh.png' }, listed),
    { name: 'GitHub', logo_url: '/gh.png' });

  // Nullable: a name with no logo is fine — the card falls back to a letter.
  assert.deepEqual(
    connectorFor({ connector_id: 'c1', connector_name: 'GitHub' }, listed),
    { name: 'GitHub', logo_url: null });

  // Missing both: the per-agent connector list still answers.
  assert.deepEqual(connectorFor({ connector_id: 'c1' }, listed),
    { name: 'Stale name', logo_url: '/stale.png' });

  // auth_required carries a *slug*, not a display name.
  assert.deepEqual(connectorFor({ connector_id: 'c9', connector: 'github' }, listed),
    { name: 'Github', logo_url: null });

  // A bare id resolves to nothing rather than putting a UUID in the title.
  assert.equal(connectorFor({ connector_id: '3341ca58-0c5f-4989-9d43-03c116681b21' }, listed), null);
  assert.equal(connectorFor(null), null);
});

test('question.metadata is capped in both directions', () => {
  const rows = detailRows({
    metadata: Object.fromEntries([
      ['payee_account', 'Changed 2 days ago'],
      ['history', [1, 2, 3]],
      ['context', { deep: 'x' }],
      ['nothing', null],
      ...Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(500)]),
    ]),
  });
  assert.equal(rows.length, 8, 'a huge metadata object cannot flood the card');
  assert.deepEqual(rows[0], ['Payee account', 'Changed 2 days ago']);
  assert.deepEqual(rows[1], ['History', '3 items'], 'nested values are summarised, never walked');
  assert.deepEqual(rows[2], ['Context', 'details']);
  assert.deepEqual(rows[3], ['Nothing', '—']);
  assert.equal(rows[4][1].length, 200, 'long values are truncated');
  assert.deepEqual(detailRows({ message: 'no metadata at all' }), []);
});

test('only pending rows are shown; resolved history is not', () => {
  const rows = [
    { id: 'a', status: 'resolved' },
    { id: 'b', status: 'pending' },
    { id: 'c', status: 'expired' },
    { id: 'd', status: 'pending' },
  ];
  assert.deepEqual(pendingRows(rows).map((r) => r.id), ['b', 'd']);
  assert.deepEqual(pendingRows(undefined), []);
});
