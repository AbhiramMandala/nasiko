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

  // ── END GENERATED ─────────────────────────────────────────────────────────
}
