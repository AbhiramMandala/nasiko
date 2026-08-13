/**
 * Proves the nav-extension seam is behaviour-preserving in BOTH editions.
 *
 * Removing the fork means `/navigation.js` is now shared and `/nav-ext.js` is
 * resolved through the asset overlay: the OSS no-op, or EE's real extension. A
 * "page loads without errors" check cannot tell you whether the nav still has the
 * right items in it — this can, and that is the whole risk of the change.
 */
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';
import { resolve } from 'node:path';

const ROOT = resolve(process.argv[2] || '.');
const results = [];
const ok = (name, cond, detail = '') => results.push({ name, pass: !!cond, detail: String(detail) });

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: ['--no-sandbox'],
});

/** Load a page under a given overlay and read the nav the shell would render. */
async function readNav({ layers, ctx }) {
  const { server, port } = await startServer(ROOT, 0, layers);
  const base = `http://localhost:${port}`;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/**', (route) => {
    const url = route.request().url();
    let body = { data: [], total: 0 };
    if (url.includes('/org/context')) body = ctx;
    if (url.includes('/me')) body = { id: 'u1', role: ctx?.role || 'member', is_superuser: !!ctx?.is_superuser };
    if (url.includes('/observability/trace/')) {
      body = { data: { trace: { id: 't1', project_session_id: 'sess-42', spans: [], latency_ms: 12 } } };
    }
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`${base}/settings.html`, { waitUntil: 'load' });
  const out = await page.evaluate(async () => ({
    items: (await window.fetchNavigation()).map((i) => i.title),
    rail: (await window.fetchNavigation()).filter((i) => i.rail).map((i) => i.title),
    org: await window.fetchModuleNav('org'),
    obs: await window.fetchModuleNav('observability'),
    agents: await window.fetchModuleNav('agents'),
    trace: await window.fetchTraceDetail('t1'),
  }));
  await page.close();
  server.close();
  return { ...out, errors };
}

const ADMIN = { role: 'admin', is_superuser: true, department_id: null, team_id: null };
const MEMBER = { role: 'member', is_superuser: false, department_id: null, team_id: null };

// ── OSS: no EE layer, so /nav-ext.js resolves to the no-op default ───────────
const oss = await readNav({ layers: ['oss/ui/web'], ctx: ADMIN });
ok('OSS: no page errors', oss.errors.length === 0, oss.errors[0] || '');
ok('OSS: base items present', oss.items.includes('Orchestrator') && oss.items.includes('Agents') && oss.items.includes('Settings'), oss.items.join(','));
ok('OSS: no EE org items leak in', !oss.items.includes('Users') && !oss.items.includes('Access Control'), oss.items.filter((t) => ['Users','Access Control','Teams','Departments'].includes(t)).join(','));
ok('OSS: rail set unchanged (8 icons)', oss.rail.length === 8, `${oss.rail.length}: ${oss.rail.join(',')}`);
ok('OSS: org module has no tree', oss.org === null, JSON.stringify(oss.org)?.slice(0, 60));
ok('OSS: observability still lists Resources, with no Platform group',
   JSON.stringify(oss.obs).includes('/resources.html') && !JSON.stringify(oss.obs).includes('Platform'),
   JSON.stringify(oss.obs?.groups?.map((g) => g.label)));
ok('OSS: agents module tree resolves', oss.agents?.groups?.length > 0, JSON.stringify(oss.agents?.title));

// ── EE overlay: ee/ui/web wins, so /nav-ext.js is EE's extension ─────────────
const ee = await readNav({ layers: ['ee/ui/web', 'oss/ui/web'], ctx: ADMIN });
ok('EE admin: no page errors', ee.errors.length === 0, ee.errors[0] || '');
for (const t of ['Users', 'Departments', 'Teams', 'Access Control', 'Resources', 'Agent Runtime', 'Team Access', 'Group Mappings']) {
  ok(`EE admin: nav includes "${t}"`, ee.items.includes(t), ee.items.join(','));
}
ok('EE admin: org tree titled "Access control"', ee.org?.title === 'Access control', ee.org?.title);
ok('EE admin: org tree has Organisation + Access groups',
   ee.org?.groups?.map((g) => g.label).join(',') === 'Organisation,Access',
   ee.org?.groups?.map((g) => g.label).join(','));
// Name-agnostic: assert WHERE the link is, not what the group happens to be
// called. (The shared group is "Home", not "Monitoring" — assuming the name is
// how this assertion first broke.)
const groupHolding = (tree, url) =>
  tree?.groups?.filter((g) => g.items.some((i) => i.url === url)).map((g) => g.label) ?? [];
ok('EE admin: Resources appears only under the admin Platform group',
   groupHolding(ee.obs, '/resources.html').join(',') === 'Platform',
   `in groups: ${groupHolding(ee.obs, '/resources.html').join(',') || 'none'}`);
ok('OSS: Resources is NOT under a Platform group',
   groupHolding(oss.obs, '/resources.html').length === 1 &&
   groupHolding(oss.obs, '/resources.html')[0] !== 'Platform',
   `in groups: ${groupHolding(oss.obs, '/resources.html').join(',') || 'none'}`);
ok('EE admin: Agent runtime under Platform',
   JSON.stringify(ee.obs?.groups?.find((g) => g.label === 'Platform')).includes('/runtime.html'));
ok('EE: non-extended modules fall through to the shared tree',
   JSON.stringify(ee.agents) === JSON.stringify(oss.agents),
   'agents tree differs between editions');

// ── EE, low-privilege: the role gates must still bite ───────────────────────
const eeMember = await readNav({ layers: ['ee/ui/web', 'oss/ui/web'], ctx: MEMBER });
ok('EE member: no page errors', eeMember.errors.length === 0, eeMember.errors[0] || '');
ok('EE member: sees the base org pages', eeMember.items.includes('Users'), eeMember.items.join(','));
for (const t of ['Access Control', 'Resources', 'Agent Runtime', 'Group Mappings', 'Team Access']) {
  ok(`EE member: "${t}" is gated out`, !eeMember.items.includes(t), eeMember.items.join(','));
}
ok('EE member: observability has no Platform group',
   !eeMember.obs?.groups?.some((g) => g.label === 'Platform'),
   eeMember.obs?.groups?.map((g) => g.label).join(','));
ok('EE member: org tree titled "Organisation" with no Access group',
   eeMember.org?.title === 'Organisation' && !eeMember.org?.groups?.some((g) => g.label === 'Access'),
   `${eeMember.org?.title} / ${eeMember.org?.groups?.map((g) => g.label).join(',')}`);

// ── The bug the fork caused: fetchTraceDetail must return the TRACE object ───
ok('OSS: fetchTraceDetail returns the trace (project_session_id readable)',
   oss.trace?.project_session_id === 'sess-42', JSON.stringify(oss.trace)?.slice(0, 80));
ok('EE: fetchTraceDetail returns the trace too — the drift is gone',
   ee.trace?.project_session_id === 'sess-42', JSON.stringify(ee.trace)?.slice(0, 80));

await browser.close();

let fails = 0;
for (const r of results) {
  if (!r.pass) fails++;
  console.log(`  ${r.pass ? 'ok  ' : 'FAIL'} ${r.name}${r.pass ? '' : '   [' + r.detail + ']'}`);
}
console.log(`\nnav seam: ${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
