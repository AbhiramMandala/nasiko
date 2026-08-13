/**
 * The typed `window` contract.
 *
 * The UI has no build step, so this file compiles to nothing and ships nowhere.
 * It exists purely so `tsc --checkJs` can check the one seam nothing else could:
 * the ~65 data functions and the server-injected globals, all previously resolved
 * by string name with no compiler, no types and no test. That gap is the memo's
 * "nothing catches a broken contract before a person does".
 *
 * The data-function block is GENERATED from `common/services/data-functions.js`
 * by `oss/ui/scripts/gen-globals.mjs`. Do not hand-edit it — run the generator.
 *
 * There is deliberately NO index signature on `Window`. Adding one would make
 * every typo type-check, which is precisely the failure this file exists to catch.
 */

/** Server-injected runtime config (multi-tenant BFF; see services/api.js). */
interface NasikoConfig {
  /** Absolute base for the workspace control plane. Empty/absent = same origin. */
  apiBase?: string;
  /** Set by debug builds so dev-only assertions throw instead of logging. */
  dev?: boolean;
}

/** Rail + topbar item, as returned by `fetchNavigation`. */
interface NavItem {
  title: string;
  url: string;
  icon?: string;
  /** Promotes the item to a rail module icon. */
  rail?: boolean;
}

/** A module tree, as returned by `fetchModuleNav`. */
interface ModuleNav {
  title: string;
  icon?: string;
  groups: Array<{ label: string; items: Array<{ label: string; url?: string; section?: string }> }>;
}

/** The shape every list data source must return (see services/query.js). */
interface ListResult {
  data: any[];
  total: number;
}

interface Window {
  nasikoConfig?: NasikoConfig;
  /** Server-injected chrome hints for the multi-tenant shell (mtui.rs). */
  nasikoChrome?: { workspaces?: Array<{ id: string; name: string }> } | null;

  /** The shell navigation contract, read by <app-header> and <app-module-nav>. */
  fetchNavigation?: () => Promise<NavItem[]>;
  fetchModuleNav?: (module: string) => Promise<ModuleNav | null>;

  /** Optional per-distribution override consumed by setup-cli-page. */
  setupCliSteps?: Array<Record<string, any>>;

  // ── GENERATED: data functions (do not hand-edit) ──────────────────────────
  authorizeMcpOauth: (connectorId?: any) => Promise<any>;
  clearDefaultLlmConfig: (id?: any) => Promise<any>;
  connectMcpService: (body?: any) => Promise<any>;
  createLlmConfig: (body?: any) => Promise<any>;
  createWorkflow: (body?: any) => Promise<any>;
  deleteLlmConfig: (id?: any) => Promise<any>;
  deleteMcpConnector: (connectorId?: any) => Promise<any>;
  deleteMcpCredential: (connectorId?: any) => Promise<any>;
  deleteSession: (sessionId?: any) => Promise<any>;
  deleteWorkflow: (id?: any) => Promise<any>;
  disconnectMcpConnection: (connectorId?: any) => Promise<any>;
  fetchAgentMcpConnectorTools: (agentId?: any, connectorId?: any) => Promise<any>;
  fetchAgentMcpConnectors: (agentId?: any) => Promise<any>;
  fetchAgentMcpToolRules: (agentId?: any) => Promise<any>;
  fetchAgentResourceStats: (agentRef?: any) => Promise<any>;
  fetchAgents: (query?: any, page?: any, limit?: any) => Promise<any>;
  fetchAllExecutions: (limit?: any, offset?: any) => Promise<any>;
  fetchBuilds: (query?: any, page?: any, limit?: any) => Promise<any>;
  fetchChatSession: (sessionId?: any) => Promise<any>;
  fetchContainers: (query?: any, page?: any, limit?: any) => Promise<any>;
  fetchExecution: (id?: any) => Promise<any>;
  fetchFlowDetail: (flowId?: any) => Promise<any>;
  fetchFlows: (query?: any, page?: any, limit?: any) => Promise<any>;
  fetchLlmConfigs: () => Promise<any>;
  fetchLlmProviders: () => Promise<any>;
  fetchMcpBuildLogs: (connectorId?: any, tail?: any) => Promise<any>;
  fetchMcpBuildStatus: (connectorId?: any) => Promise<any>;
  fetchMcpConnections: () => Promise<any>;
  fetchMcpConnectors: () => Promise<any>;
  fetchMcpCredentialStatus: (connectorId?: any) => Promise<any>;
  fetchMcpMyUploads: () => Promise<any>;
  fetchMcpOauthStatus: (connectorId?: any) => Promise<any>;
  fetchMcpToolkits: () => Promise<any>;
  fetchObservabilitySession: (sessionId?: any) => Promise<any>;
  fetchObservabilitySessions: (limit?: any, offset?: any) => Promise<any>;
  fetchObservabilityTrace: (traceId?: any) => Promise<any>;
  fetchResourceStats: () => Promise<any>;
  fetchSecretsList: () => Promise<any>;
  fetchSessions: (query?: any, limit?: any, cursor?: any) => Promise<any>;
  fetchSettings: () => Promise<any>;
  fetchSpanDetail: (traceId?: any, spanId?: any) => Promise<any>;
  fetchTokenopsDashboard: (startTime?: any, endTime?: any) => Promise<any>;
  fetchTraceDetail: (traceId?: any) => Promise<any>;
  fetchUsageByAgent: (query?: any, page?: any, limit?: any) => Promise<any>;
  fetchUsageByModel: (query?: any, page?: any, limit?: any) => Promise<any>;
  fetchUsageHistory: (days?: any) => Promise<any>;
  fetchUsageSummary: () => Promise<any>;
  fetchUserSearch: (query?: any) => Promise<any>;
  fetchWorkflow: (id?: any) => Promise<any>;
  fetchWorkflowExecutions: (id?: any, limit?: any, offset?: any) => Promise<any>;
  fetchWorkflows: (limit?: any, offset?: any) => Promise<any>;
  generateWorkflow: (description?: any) => Promise<any>;
  probeMcpConnector: (url?: any) => Promise<any>;
  registerMcpConnector: (body?: any) => Promise<any>;
  revokeMcpOauthToken: (connectorId?: any) => Promise<any>;
  runWorkflow: (id?: any) => Promise<any>;
  saveAgentMcpToolRules: (agentId?: any, rules?: any) => Promise<any>;
  saveSettings: (settings?: any) => Promise<any>;
  setAgentMcpConnectorAccess: (agentId?: any, connectorId?: any, enabled?: any) => Promise<any>;
  setDefaultLlmConfig: (id?: any) => Promise<any>;
  setMcpCredential: (connectorId?: any, value?: any) => Promise<any>;
  updateMcpConnector: (connectorId?: any, body?: any) => Promise<any>;
  updateWorkflow: (id?: any, body?: any) => Promise<any>;
  uploadMcpServerGithub: (body?: any) => Promise<any>;
  uploadMcpServerZip: (formData?: any) => Promise<any>;
  // ── END GENERATED ─────────────────────────────────────────────────────────
}
