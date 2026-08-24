// MCP connector detail fixtures — shapes match GET /api/mcp/connectors/{id}
// (oss/mcp-gateway/src/connectors.rs `connector_dto`) plus the tools, credential,
// OAuth, build-log and grant endpoints the page reads. Envelope
// {data, status_code, message}. The default connector is an uploaded build owned
// by the caller, so every tab renders: Overview (danger zone included),
// Access & security, and Logs.

const CONNECTOR_ID = '6f1d2a3b-1111-4a4a-9b9b-000000000003';

const connector = {
  connector_id: CONNECTOR_ID,
  provider_type: 'mcp_server',
  owner_id: 'u-001',
  name: 'postgres-tools',
  display_name: 'Postgres Tools',
  url: 'http://mcp-postgres-tools.agents.svc.cluster.local:8080/mcp',
  transport: 'streamable_http',
  auth_type: 'bearer',
  url_param_name: null,
  credential_header_name: 'Authorization',
  description: 'SQL query and schema-inspection tools for the analytics warehouse, built from an uploaded source archive.',
  logo_url: null,
  is_active: true,
  oauth_configured: false,
  source_kind: 'uploaded_build',
  build_status: 'succeeded',
  setup_status: 'active',
  setup_error: null,
  created_at: '2026-07-20T09:12:00Z',
  updated_at: '2026-07-29T14:30:00Z',
  is_owner: true,
  version: 'v2',
  tool_count: 5,
  is_connected: true,
  owner_username: 'admin',
};

const tools = [
  { name: 'run_query', description: 'Run a read-only SQL query against the warehouse and return rows as JSON.' },
  { name: 'describe_table', description: 'Column names, types, and constraints for one table.' },
  { name: 'list_schemas', description: 'Every schema the connection can see.' },
  { name: 'explain_query', description: 'Planner output for a query, without executing it.' },
  { name: 'kill_query', description: 'Cancel a running query by backend PID. Destructive.' },
];

// Grants — GET /consumers (owner/admin view) plus the EE org routes the page
// probes to decide whether Team/Department tabs exist at all.
const consumers = {
  agents: [],
  users: [
    { user_id: 'u-101', username: 'dana', display_name: 'Dana Ruiz',
      granted_by: 'u-001', granted_by_username: 'admin', created_at: '2026-07-22T11:00:00Z' },
    { user_id: 'u-102', username: 'sam', display_name: 'Sam Okafor',
      granted_by: 'u-001', granted_by_username: 'admin', created_at: '2026-08-01T09:30:00Z' },
  ],
  teams: [
    { id: 't-001', name: 'Platform', granted_by: 'u-001', created_at: '2026-07-25T16:20:00Z' },
  ],
  departments: [
    { id: 'd-001', name: 'Engineering', granted_by: 'u-001', created_at: '2026-07-21T08:00:00Z' },
  ],
};

const buildLogs = [
  '#8 [4/6] RUN pip install --no-cache-dir -r requirements.txt',
  '#8 12.41 Collecting mcp>=1.2.0',
  '#8 18.77 Successfully installed httpx-0.28.1 mcp-1.9.0 pydantic-2.11.3',
  '#8 DONE 19.1s',
  '#9 [5/6] COPY . /app',
  '#9 DONE 0.2s',
  '#10 [6/6] CMD ["python", "server.py"]',
  '#10 DONE 0.0s',
  'build: image tagged mcp-postgres-tools:v2',
  'deploy: container healthy after 4.2s',
].join('\n');

export default {
  fetch: [
    [{ method: 'GET', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+$/ },
      { data: connector, status_code: 200, message: 'Connector retrieved successfully' }],

    [{ method: 'GET', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/tools$/ },
      { data: { tools }, status_code: 200, message: 'Connector tools retrieved successfully' }],

    [{ method: 'GET', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/credential\/status$/ },
      { data: { connector_id: CONNECTOR_ID, name: 'postgres-tools', connected: true, auth_type: 'bearer' },
        status_code: 200, message: 'Credential status retrieved successfully' }],
    [{ method: 'POST', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/credential$/ },
      { data: { connector_id: CONNECTOR_ID, connected: true, error: null },
        status_code: 201, message: 'Credential registered and verified successfully' }],
    [{ method: 'DELETE', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/credential$/ },
      { data: null, status_code: 200, message: 'Credential deleted successfully' }],

    [{ method: 'GET', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/oauth\/status$/ },
      { data: { connector_id: CONNECTOR_ID, authorized: false, expires_at: null },
        status_code: 200, message: 'OAuth status retrieved successfully' }],

    [{ method: 'GET', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/build-logs/ },
      { data: buildLogs, status_code: 200, message: 'build logs retrieved successfully' }],

    [{ method: 'DELETE', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+$/ },
      { data: null, status_code: 200, message: 'Connector deleted successfully' }],

    // Grants
    [{ method: 'GET', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/consumers$/ },
      { data: consumers, status_code: 200, message: 'Connector consumers retrieved successfully' }],
    // Served only by EE — its mere presence is what turns on the Team and
    // Department tabs. Bare `{teams, total}`, exactly as ee/server/src/teams.rs
    // answers it (no `data` envelope).
    [{ method: 'GET', path: /^\/api\/teams(\?|$)/ },
      { teams: [{ id: 't-001', name: 'Platform' }], total: 1 }],
    [{ method: 'GET', path: /^\/api\/mcp\/share-targets\?/ },
      { data: { users: [
        { user_id: 'u-103', username: 'priya', display_name: 'Priya Nair' },
        { user_id: 'u-104', username: 'lee', display_name: 'Lee Chen' },
      ] }, status_code: 200, message: 'ok' }],
    [{ method: 'GET', path: /^\/api\/search\/teams\?/ },
      { data: [{ id: 't-002', name: 'Growth' }] }],
    [{ method: 'GET', path: /^\/api\/search\/departments\?/ },
      { data: [{ id: 'd-002', name: 'Research', description: 'Applied research' }] }],
    [{ method: 'POST', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/grants\// },
      { data: null, status_code: 201, message: 'Grant created successfully' }],
    [{ method: 'DELETE', path: /^\/api\/mcp\/connectors\/[0-9a-f-]+\/grants\// },
      { data: null, status_code: 200, message: 'Grant revoked successfully' }],
  ],

  scenarios: {
    // Hover a tool card, to check the `.tile` hover the skill cards have.
    'tool-hover': async (page) => {
      await page.waitForSelector('.tile');
      await page.hover('.tile');
      await page.waitForTimeout(300);
    },
    // The delete action moved out of a Settings tab and onto Overview's tail.
    'danger-zone': async (page) => {
      await page.waitForSelector('#mdp-delete-btn');
      await page.locator('#mdp-delete-btn').scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
    },
    'grants': async (page) => {
      await page.waitForSelector('app-tabs .tab');
      await page.click('app-tabs .tab[data-key="access"]');
      await page.waitForSelector('#mdp-grants-table tbody tr');
      await page.locator('#mdp-grants-table').scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
    },
    'grant-modal': async (page) => {
      await page.waitForSelector('app-tabs .tab');
      await page.click('app-tabs .tab[data-key="access"]');
      await page.waitForSelector('#mdp-grant-open');
      await page.click('#mdp-grant-open');
      await page.fill('#mdp-grant-query input', 'pr');
      await page.waitForSelector('.mdp-picker-option');
      await page.waitForTimeout(300);
    },
    'logs-tab': async (page) => {
      await page.waitForSelector('app-tabs .tab');
      await page.click('app-tabs .tab[data-key="logs"]');
      await page.waitForFunction(() => !document.querySelector('#mdp-logs-pre').textContent.startsWith('Loading'));
    },
  },
};
