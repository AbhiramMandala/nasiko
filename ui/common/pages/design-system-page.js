/**
 * Design system gallery — every component in `common/design-system/`, rendered
 * live next to its tag name and a copy-pastable snippet.
 *
 * This page has no data source: it is the design system looking at itself, so
 * every demo is a literal in `SPECS` below. Adding a component to
 * `common/design-system/` means adding one row here — the page is the index.
 *
 * @element design-system-page
 * @note Attribute-level docs live in each component's own JSDoc header; this
 *       page shows behaviour, not the full API surface.
 */
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./design-system-page.css', import.meta.url));
import { icons } from '../utils/icons.js';
import { escAttr } from '/common/utils/escape.js';

import '/common/design-system/app-action-menu/app-action-menu.js';
import '/common/design-system/app-card/app-card.js';
import '/common/design-system/app-chart/app-chart.js';
import '/common/design-system/app-chatbox/app-chatbox.js';
import '/common/design-system/app-checkbox/app-checkbox.js';
import '/common/design-system/app-avatar/app-avatar.js';
import '/common/design-system/app-badge/app-badge.js';
import '/common/design-system/app-button/app-button.js';
import '/common/design-system/app-code-snippet/app-code-snippet.js';
import '/common/design-system/app-divider/app-divider.js';
import '/common/design-system/app-empty-state/app-empty-state.js';
import '/common/design-system/app-grid/app-grid.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-loading-bar/app-loading-bar.js';
import '/common/design-system/app-radio/app-radio.js';
import '/common/design-system/app-row/app-row.js';
import '/common/design-system/app-search/app-search.js';
import '/common/design-system/app-select/app-select.js';
import '/common/design-system/app-skeleton/app-skeleton.js';
import '/common/design-system/app-stack/app-stack.js';
import '/common/design-system/app-stat-card/app-stat-card.js';
import '/common/design-system/app-stat-row/app-stat-row.js';
import '/common/design-system/app-switch/app-switch.js';
import '/common/design-system/app-table/app-table.js';
import '/common/design-system/app-tabs/app-tabs.js';
import '/common/design-system/app-tag/app-tag.js';
import '/common/design-system/app-toolbar/app-toolbar.js';
import '/common/design-system/app-tooltip/app-tooltip.js';
import '/common/design-system/auto-complete/auto-complete.js';
import { confirmDialog } from '/common/design-system/app-modal/app-modal.js';
import { toast } from '/common/utils/toast.js';

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** `<auto-complete>` resolves its suggestions through `window[filter-function]`,
 *  so the demo has to publish one. Not a data function — no registry seam. */
window.dsDemoSuggest = (q) =>
  ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5', 'gpt-4o']
    .filter((m) => m.toLowerCase().includes(q.toLowerCase()))
    .map((m) => ({ label: m, value: m }));

/**
 * `<app-table>` needs a fetcher. The design system has no data sources, so this
 * is a literal in-page one — the same `(query, page, limit) => {data, total}`
 * contract a real page's service module implements, paging and filtering a
 * fixed list so the page navigation has more than one page to navigate.
 */
const DS_TABLE_ROWS = Array.from({ length: 23 }, (_, i) => ({
  name: ['research-agent', 'billing-agent', 'devops-agent', 'fabric-agent'][i % 4] + `-${i + 1}`,
  status: ['running', 'stopped', 'error', 'deploying'][i % 4],
  replicas: (i % 5) + 1,
  requests: 1200 - i * 37,
}));

const dsTableFetch = (query, page, limit) => {
  const q = (query || '').toLowerCase();
  const rows = q ? DS_TABLE_ROWS.filter((r) => r.name.includes(q)) : DS_TABLE_ROWS;
  const start = (page - 1) * limit;
  return { data: rows.slice(start, start + limit), total: rows.length };
};

/**
 * `<app-chart>` demos. `data` is a property, not an attribute, so these are
 * assigned in `#wire()` — the same as the tables above. One literal per chart
 * form, kept here rather than inline so the markup in the "Markup" disclosure
 * stays the markup a caller would actually write.
 */
const DS_CHART_DATA = {
  'ds-chart-line': {
    labels: ['Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug'],
    datasets: [
      { label: 'This year', data: [41200, 52800, 47600, 68100, 61400, 94127] },
      { label: 'Last year', data: [38400, 36900, 51200, 44800, 58300, 49700] },
    ],
  },
  'ds-chart-bar': {
    labels: ['Mar', 'Apr', 'May', 'Jun', 'Jul'],
    datasets: [
      { label: 'gpt-4o', data: [18, 21, 24, 33, 26] },
      { label: 'claude-opus', data: [12, 14, 13, 19, 11] },
      { label: 'embeddings', data: [7, 9, 8, 12, 6] },
    ],
  },
  'ds-chart-donut': {
    labels: ['gpt-4o 35%', 'claude 25%', 'embeddings 18%', 'gemini 12%', 'other 10%'],
    datasets: [{ label: 'Spend', data: [35, 25, 18, 12, 10] }],
  },
  // TokenOps "Spend over time": cost series on the left axis, token volume on
  // the right (`axis: 'y2'`), with two flagged anomalies on the spend series.
  'ds-chart-anomaly-line': {
    labels: Array.from({ length: 31 }, (_, i) => String(i + 1)),
    datasets: [
      { label: 'Spend', data: [310, 250, 205, 240, 280, 305, 330, 355, 450, 340,
        330, 345, 360, 365, 370, 372, 375, 374, 372, 370, 365, 360, 372, 371,
        370, 372, 370, 340, 300, 270, 245],
        anomalies: [8, { index: 22, note: 'DevOps Engineer spend 55M tokens' }] },
      { label: 'Waste', data: [85, 100, 120, 135, 145, 130, 105, 95, 110, 90,
        88, 92, 118, 112, 104, 100, 98, 96, 100, 104, 108, 104, 100, 104, 110,
        112, 108, 116, 112, 108, 110] },
      { label: 'Tokens', axis: 'y2', data: [2.2e6, 4.1e6, 5.8e6, 6.9e6, 6.1e6,
        5.4e6, 4.9e6, 5.6e6, 6.4e6, 5.2e6, 4.8e6, 5.1e6, 5.9e6, 6.6e6, 7.1e6,
        6.8e6, 7.0e6, 7.6e6, 8.1e6, 7.2e6, 6.4e6, 5.8e6, 5.1e6, 4.4e6, 3.9e6,
        3.4e6, 3.0e6, 3.6e6, 4.5e6, 5.6e6, 6.6e6] },
    ],
  },
  // TokenOps "Spend concentration": one column per hour, one pill per agent.
  'ds-chart-concentration': {
    labels: ['12am', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11',
      '12pm', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'],
    datasets: [
      { label: 'Router', data: [38, 30, 26, 24, 26, 30, 36, 42, 50, 55, 52, 48,
        50, 54, 52, 48, 44, 46, 42, 38, 40, 44, 40, 36] },
      { label: 'DevOps Engineer', data: [12, 8, 6, 5, 6, 10, 18, 30, 44, 52, 48, 40,
        44, 50, 46, 38, 30, 34, 26, 18, 22, 28, 20, 14] },
      { label: 'Finance Analyst', data: [4, 3, 2, 2, 2, 4, 8, 16, 28, 34, 30, 24,
        28, 32, 30, 22, 16, 18, 12, 8, 10, 14, 8, 5] },
      { label: 'Other', data: [2, 1, 1, 1, 1, 2, 4, 8, 12, 14, 12, 10,
        12, 14, 12, 9, 7, 8, 6, 4, 5, 6, 4, 3] },
    ],
  },
  // Row forms take a flat array. `trend` is the sentiment, not the arrow:
  // rising spend is bad news, so it is `down` next to an up arrow.
  'ds-chart-hbar': [
    { label: 'gpt-4o', value: 4200, display: '$4.2k', delta: '\u219112%', trend: 'down' },
    { label: 'claude-opus', value: 3300, display: '$3.3k', delta: '\u21915%', trend: 'down' },
    { label: 'embeddings', value: 2200, display: '$2.2k', delta: '\u21938%', trend: 'up' },
    { label: 'gemini', value: 1700, display: '$1.7k', delta: '\u21913%', trend: 'down' },
    { label: 'whisper', value: 900, display: '$0.9k', delta: '\u21932%', trend: 'up' },
  ],
  'ds-chart-progress': [
    { label: 'Budget used', value: 72 },
    { label: 'Token quota', value: 54 },
    { label: 'Seat limit', value: 36 },
    { label: 'Storage', value: 24 },
  ],
};

const DS_TABLE_COLUMNS = [
  { key: 'name', label: 'Agent', width: '40%' },
  { key: 'status', label: 'Status' },
  { key: 'replicas', label: 'Replicas' },
  { key: 'requests', label: 'Requests' },
];

const box = (n) => Array.from({ length: n }, (_, i) => `<div class="box">${i + 1}</div>`).join('');

/**
 * One row per component: the tag, a one-line blurb, and the demo markup that
 * gets both rendered and shown as source.
 * @type {Array<{group: string, tag: string, blurb: string, demo: string}>}
 */
const SPECS = [
  // ── Layout ──────────────────────────────────────────────────────────────
  {
    group: 'Layout',
    tag: 'app-stack',
    blurb: 'Vertical flex stack. gap / align / padding tokens.',
    demo: `<app-stack gap="sm" align="start">${box(3)}</app-stack>`,
  },
  {
    group: 'Layout',
    tag: 'app-row',
    blurb: 'Horizontal flex row. Adds justify + wrap over app-stack.',
    demo: `<app-row gap="sm" justify="between">${box(3)}</app-row>`,
  },
  {
    group: 'Layout',
    tag: 'app-grid',
    blurb: 'CSS grid. Integer columns, or min-width alone for auto-fill tracks.',
    demo: `<app-grid min-width="120px" gap="sm">${box(6)}</app-grid>`,
  },
  {
    group: 'Layout',
    tag: 'app-divider',
    blurb: 'Rule between blocks. Type (thick) \u00d7 Style (solid/dashed/dotted) \u00d7 Tone (subtle), horizontal or vertical \u2014 and `label` folds Figma\u2019s labelled divider in as a fourth, composable axis.',
    demo: `<app-stack gap="sm">
  <app-divider></app-divider>
  <app-divider line="dashed"></app-divider>
  <app-divider line="dotted"></app-divider>
  <app-divider thick tone="subtle"></app-divider>
  <app-divider thick line="dashed" tone="subtle"></app-divider>
  <app-divider label="Section"></app-divider>
  <app-divider label="Subtle dashed" line="dashed" tone="subtle"></app-divider>
  <app-row gap="md">
    <span class="demo-note">Vertical</span>
    <app-divider vertical></app-divider>
    <span class="demo-note">thick</span>
    <app-divider vertical thick></app-divider>
    <span class="demo-note">dotted</span>
    <app-divider vertical line="dotted"></app-divider>
  </app-row>
</app-stack>`,
  },
  {
    group: 'Layout',
    tag: 'app-toolbar',
    blurb: 'Action bar with start / end slots.',
    demo: `<app-toolbar aria-label="Demo actions">
  <div data-slot="start"><app-badge variant="info">12 agents</app-badge></div>
  <div data-slot="end"><app-button size="sm" variant="secondary">Refresh</app-button></div>
</app-toolbar>`,
  },
  {
    group: 'Layout',
    tag: 'app-tabs',
    blurb: 'Tab bar that owns its panels — children carry data-tab / data-label.',
    demo: `<app-tabs active="overview">
  <div data-tab="overview" data-label="Overview">Overview panel</div>
  <div data-tab="logs" data-label="Logs">Logs panel</div>
  <div data-tab="config" data-label="Config">Config panel</div>
</app-tabs>`,
  },
  {
    group: 'Layout',
    tag: 'app-tabs',
    blurb: 'Strip mode — the page renders the buttons (data-driven filters with counts) and owns the content; listen for tab-change.',
    demo: `<app-tabs strip>
  <button class="tab" type="button" role="tab" aria-selected="true" data-key="all">All<span class="n">24</span></button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-key="running">Running<span class="n">18</span></button>
  <button class="tab" type="button" role="tab" aria-selected="false" data-key="failed">Failed<span class="n">6</span></button>
</app-tabs>`,
  },

  // ── Controls ────────────────────────────────────────────────────────────
  {
    group: 'Controls',
    tag: 'app-button',
    blurb: 'Figma\u2019s Type \u00d7 Tone \u00d7 Size matrix (node 11:4247) \u2014 Primary, Secondary, Tertiary, Ghost, Destructive 1, Destructive 2. Three sizes: 28 / 32 / 36px. Borders change on hover.',
    demo: `<app-stack gap="sm" align="start">
  <app-row gap="sm" wrap align="center">
    <app-button>Primary</app-button>
    <app-button variant="secondary">Secondary</app-button>
    <app-button variant="tertiary">Tertiary</app-button>
    <app-button variant="ghost">Ghost</app-button>
  </app-row>
  <app-row gap="sm" wrap align="center">
    <app-button variant="danger">Destructive 1</app-button>
    <app-button variant="danger-secondary">Destructive 2</app-button>
    <app-button variant="ghost-danger">Destructive ghost</app-button>
    <app-button variant="dark">Dark (alias of primary)</app-button>
  </app-row>
  <app-row gap="sm" wrap align="center">
    <app-button size="sm">Small 28</app-button>
    <app-button size="md">Medium 32</app-button>
    <app-button>Large 36</app-button>
  </app-row>
  <app-row gap="sm" wrap align="center">
    <app-button loading>Loading</app-button>
    <app-button disabled>Disabled</app-button>
    <app-button variant="ghost" disabled>Ghost disabled</app-button>
  </app-row>
</app-stack>`,
  },
  {
    group: 'Controls',
    tag: 'app-chatbox',
    blurb: 'The chat composer, as the orchestrator and chat pages use it \u2014 auto-growing textarea, Enter to send (Shift+Enter for a newline), voice recording (F8 / Alt+R) with a live timer, drag-and-drop or picked file attachments, and a loading state the owner clears with setLoading(false). Fires chatbox-submit; the demo below echoes it back.',
    demo: `<app-stack gap="sm" align="start">
  <app-chatbox data-demo="chatbox" placeholder="Describe the task you want to execute"></app-chatbox>
  <span class="demo-note" data-demo="chatbox-out">chatbox-submit lands here.</span>
  <app-chatbox no-attachments placeholder="No attachments variant..."></app-chatbox>
</app-stack>`,
  },
  {
    group: 'Controls',
    tag: 'app-button[icon-only]',
    blurb: 'Figma\u2019s Icon Button (4158:1100) \u2014 this same matrix squared: 28 / 32 / 36px, radius 6 / 8 / 8, icon 12 / 16 / 20. All six of its groups below.',
    demo: `<app-stack gap="sm" align="start">
  <app-row gap="md" wrap align="end">
    <app-stack gap="xs" align="start">
      <span class="demo-note">Primary</span>
      <app-button icon-only title="Primary">${icons.plus()}</app-button>
    </app-stack>
    <app-stack gap="xs" align="start">
      <span class="demo-note">Secondary</span>
      <app-button icon-only variant="secondary" title="Secondary">${icons.edit()}</app-button>
    </app-stack>
    <app-stack gap="xs" align="start">
      <span class="demo-note">Tertiary</span>
      <app-button icon-only variant="tertiary" title="Tertiary">${icons.copy()}</app-button>
    </app-stack>
    <app-stack gap="xs" align="start">
      <span class="demo-note">Ghost</span>
      <app-button icon-only variant="ghost" title="Ghost">${icons.moreVertical()}</app-button>
    </app-stack>
    <app-stack gap="xs" align="start">
      <span class="demo-note">Destructive 1</span>
      <app-button icon-only variant="danger" title="Destructive 1">${icons.trash()}</app-button>
    </app-stack>
    <app-stack gap="xs" align="start">
      <span class="demo-note">Destructive 2</span>
      <app-button icon-only variant="danger-secondary" title="Destructive 2">${icons.trash()}</app-button>
      <app-button icon-only variant="ghost-danger" title="Destructive ghost">${icons.trash()}</app-button>
    </app-stack>
    <app-stack gap="xs" align="start">
      <span class="demo-note">Disabled</span>
      <app-button icon-only disabled title="Disabled">${icons.refresh()}</app-button>
    </app-stack>
  </app-row>
  <app-row gap="sm" wrap align="center">
    <app-button icon-only size="sm" title="Small 28">${icons.plus()}</app-button>
    <app-button icon-only size="md" title="Medium 32">${icons.plus()}</app-button>
    <app-button icon-only title="Large 36">${icons.plus()}</app-button>
    <span class="demo-note">variant="icon" is the ghost-coloured shorthand:</span>
    <app-button variant="icon" title="Legacy icon variant">${icons.x()}</app-button>
  </app-row>
</app-stack>`,
  },
  {
    group: 'Controls',
    tag: 'app-action-menu',
    blurb: 'Icon trigger + dropdown of actions. Fires action-select.',
    demo: `<app-action-menu trigger-title="Options"
  items='[{"id":"restart","label":"Restart"},{"id":"logs","label":"View logs"},{"id":"rm","label":"Delete"}]'>
  ${icons.moreVertical()}
</app-action-menu>`,
  },
  {
    group: 'Controls',
    tag: 'auto-complete',
    blurb: 'Typeahead input. Suggestions come from window[filter-function].',
    demo: `<auto-complete placeholder="Search models…" aria-label="Model"
  filter-function="dsDemoSuggest"></auto-complete>`,
  },

  {
    group: 'Controls',
    tag: 'app-input',
    blurb: 'Figma’s Input (4190:129) — State × Size. Seven states (default, hover, focus, disabled, error, success, read-only) × two sizes (32 / 28px), with label, hint, counter, required marker, icon slots and an opt-in show/hide toggle on password fields. Hover and focus are pseudo-classes; the state attribute renders them statically for review.',
    demo: `<app-stack gap="md" align="start">
  <app-grid min-width="240px" gap="md">
    <app-input label="Label" hint="Hint text" placeholder="Placeholder"></app-input>
    <app-input label="Label" hint="Hint text" placeholder="Placeholder" state="hover"></app-input>
    <app-input label="Label" hint="Hint text" placeholder="Placeholder" state="focus"></app-input>
    <app-input label="Label" hint="Hint text" placeholder="Placeholder" disabled></app-input>
    <app-input label="Label" hint="Enter a valid name" placeholder="Placeholder" state="error"></app-input>
    <app-input label="Label" hint="Hint text" placeholder="Placeholder" state="success"></app-input>
    <app-input label="Label" hint="Hint text" placeholder="Placeholder" readonly></app-input>
  </app-grid>
  <app-grid min-width="240px" gap="md">
    <app-input size="sm" label="Small 28" hint="Hint text" placeholder="Placeholder"></app-input>
    <app-input label="Required" required hint="With a counter" count="12/100" placeholder="Placeholder"></app-input>
    <app-input label="With icons" hint="Leading + trailing" placeholder="Search agents…">
      <span data-slot="leading">${icons.search()}</span>
      <span data-slot="trailing">${icons.x()}</span>
    </app-input>
    <app-input label="Password" type="password" reveal value="hunter2-and-then-some"
      hint="reveal adds the show/hide toggle"></app-input>
  </app-grid>
</app-stack>`,
  },
  {
    group: 'Controls',
    tag: 'app-search',
    blurb: 'Figma’s Search (4258:104) — the search <em>field</em>, not a results surface. State × Size: five states (default, hover, focus, disabled, loading) × two sizes (36 / 28px). No label or hint — the component is the box. “Has value” is a boolean, not a state, so the trailing clear follows the value and steps aside for the spinner.',
    demo: `<app-stack gap="md" align="start">
  <app-grid min-width="240px" gap="md">
    <app-search aria-label="Search"></app-search>
    <app-search aria-label="Search" state="hover"></app-search>
    <app-search aria-label="Search" state="focus"></app-search>
    <app-search aria-label="Search" value="claude-opus"></app-search>
    <app-search aria-label="Search" loading value="claude-opus"></app-search>
    <app-search aria-label="Search" disabled></app-search>
  </app-grid>
  <app-grid min-width="240px" gap="md">
    <app-search size="sm" aria-label="Search" placeholder="Filter agents…"></app-search>
    <app-search size="sm" aria-label="Search" value="router" placeholder="Filter agents…"></app-search>
    <app-search size="sm" aria-label="Search" loading placeholder="Filter agents…"></app-search>
  </app-grid>
</app-stack>`,
  },
  {
    group: 'Controls',
    tag: 'app-select',
    blurb: 'Figma’s Select (4581:45) — the trigger, matched to the input box plus a gold chevron. A native &lt;select&gt;, so the popup list is the OS one: Figma’s custom listbox (4569:27) and its option states are not reachable here.',
    demo: `<app-grid min-width="240px" gap="md">
  <app-select label="Role" placeholder="Select role" hint="Hint text"
    options='["Admin","Editor","Viewer","Contributor","Billing","Guest"]'></app-select>
  <app-select label="Role" placeholder="Select role" state="hover"
    options='["Admin","Editor"]'></app-select>
  <app-select label="Role" placeholder="Select role" state="focus"
    options='["Admin","Editor"]'></app-select>
  <app-select label="Role" placeholder="Select role" disabled
    options='["Admin","Editor"]'></app-select>
  <app-select label="Role" placeholder="Select role" state="error" hint="Pick a role"
    options='["Admin","Editor"]'></app-select>
  <app-select size="sm" label="Small 28" placeholder="Select role"
    options='["Admin","Editor"]'></app-select>
</app-grid>`,
  },
  {
    group: 'Controls',
    tag: 'app-checkbox',
    blurb: 'Figma’s Checkbox Items (119:1379) × Checkbox (1815:46651) — Status × Type: five statuses × selected / unselected / indeterminate. 20px box, radius 4. In the error status the fill drops back to white and the glyph carries the red.',
    demo: `<app-stack gap="md" align="start">
  <app-row gap="lg" wrap align="start">
    <app-checkbox checked label="Selected"></app-checkbox>
    <app-checkbox checked state="hover" label="Hover"></app-checkbox>
    <app-checkbox checked state="focus" label="Focus"></app-checkbox>
    <app-checkbox checked disabled label="Disabled"></app-checkbox>
    <app-checkbox checked state="error" label="Error"></app-checkbox>
  </app-row>
  <app-row gap="lg" wrap align="start">
    <app-checkbox label="Unselected"></app-checkbox>
    <app-checkbox state="hover" label="Hover"></app-checkbox>
    <app-checkbox state="focus" label="Focus"></app-checkbox>
    <app-checkbox disabled label="Disabled"></app-checkbox>
    <app-checkbox state="error" label="Error"></app-checkbox>
  </app-row>
  <app-row gap="lg" wrap align="start">
    <app-checkbox indeterminate label="Indeterminate"></app-checkbox>
    <app-checkbox indeterminate state="hover" label="Hover"></app-checkbox>
    <app-checkbox indeterminate state="focus" label="Focus"></app-checkbox>
    <app-checkbox indeterminate disabled label="Disabled"></app-checkbox>
    <app-checkbox indeterminate state="error" label="Error"></app-checkbox>
  </app-row>
  <app-checkbox checked label="With subtext"
    hint="Subtext sits 2px under the label, in body/tertiary."></app-checkbox>
</app-stack>`,
  },
  {
    group: 'Controls',
    tag: 'app-radio',
    blurb: 'Figma’s Radio Button (88:1274) × Radio Field (1815:31229). 20px ring, 12px dot. The ring colour tracks status only — it never turns brand when selected; the dot alone carries selection. Grouping is native: same name attribute.',
    demo: `<app-stack gap="md" align="start">
  <app-row gap="lg" wrap align="start">
    <app-radio checked label="Selected"></app-radio>
    <app-radio checked state="hover" label="Hover"></app-radio>
    <app-radio checked state="focus" label="Focus"></app-radio>
    <app-radio checked disabled label="Disabled"></app-radio>
    <app-radio checked state="error" label="Error"></app-radio>
  </app-row>
  <app-row gap="lg" wrap align="start">
    <app-radio label="Unselected"></app-radio>
    <app-radio state="hover" label="Hover"></app-radio>
    <app-radio state="focus" label="Focus"></app-radio>
    <app-radio disabled label="Disabled"></app-radio>
    <app-radio state="error" label="Error"></app-radio>
  </app-row>
  <app-stack gap="md" align="start">
    <app-radio name="ds-demo-runtime" value="docker" checked label="Docker"
      hint="Single-node, one replica per agent."></app-radio>
    <app-radio name="ds-demo-runtime" value="k8s" label="Kubernetes"
      hint="Deployments plus KEDA autoscaling."></app-radio>
  </app-stack>
</app-stack>`,
  },
  {
    group: 'Controls',
    tag: 'app-switch',
    blurb: 'Figma’s Toggle Item (88:822) × Toggle (88:945) — Size × Type × Status. 40×24 and 36×20 tracks. Only the On track has a hover step, and the disabled paint is the same grey on or off.',
    demo: `<app-stack gap="md" align="start">
  <app-row gap="lg" wrap align="center">
    <app-switch checked label="On"></app-switch>
    <app-switch checked state="hover" label="On hover"></app-switch>
    <app-switch checked state="focus" label="On focus"></app-switch>
    <app-switch checked disabled label="On disabled"></app-switch>
  </app-row>
  <app-row gap="lg" wrap align="center">
    <app-switch label="Off"></app-switch>
    <app-switch state="hover" label="Off hover"></app-switch>
    <app-switch state="focus" label="Off focus"></app-switch>
    <app-switch disabled label="Off disabled"></app-switch>
  </app-row>
  <app-row gap="lg" wrap align="center">
    <app-switch size="sm" checked label="Small 36×20"></app-switch>
    <app-switch size="sm" label="Small off"></app-switch>
  </app-row>
  <div style="width:320px">
    <app-switch layout="settings" checked label="Capture prompt content"
      hint="Sends gen_ai.input/output.messages to Loki."></app-switch>
  </div>
</app-stack>`,
  },

  // ── Overlays ────────────────────────────────────────────────────────────
  {
    group: 'Overlays',
    tag: 'app-modal',
    blurb: 'Native <dialog> with heading, body, footer slot, ESC + backdrop dismiss. Two ways in, one component: write the markup, or call the confirmDialog({…}) → Promise&lt;boolean&gt; export for a yes/no dialog (replaces window.confirm()).',
    demo: `<app-row gap="sm" align="center" wrap>
  <app-button data-demo="open-modal">Open modal</app-button>
  <app-button variant="danger" data-demo="confirm">Delete agent…</app-button>
  <span class="demo-out" data-demo="confirm-out">—</span>
</app-row>
<app-modal id="ds-demo-modal" heading="Deploy agent">
  <p>This agent will be pulled and started on the configured runtime.</p>
  <div data-slot="footer">
    <app-button variant="secondary" data-demo="close-modal">Cancel</app-button>
    <app-button data-demo="close-modal">Deploy</app-button>
  </div>
</app-modal>

<!-- Same component, built in JS instead of markup — this is what the red button runs:
     const ok = await confirmDialog({ title: 'Delete agent?', message: '…',
                                      confirmLabel: 'Delete', danger: true }); -->`,
  },
  {
    group: 'Overlays',
    tag: 'app-tooltip',
    blurb: 'attachTooltip(el, text), or just data-tooltip — the module auto-scans.',
    demo: `<app-button variant="secondary" data-tooltip="Search · ⌘K">Hover me</app-button>`,
  },

  // ── Data display ────────────────────────────────────────────────────────
  {
    group: 'Data display',
    tag: 'app-avatar',
    blurb: 'Figma\u2019s Avatar + Avatar Label \u2014 one element, six sizes (20/24/32/40/48/64). Content falls back image \u2192 initials \u2192 user glyph. Add label/description for the identity stack; a single line centres against the circle. `filled` is the dark chip.',
    demo: `<app-stack gap="md" align="start">
  <app-row gap="md" wrap align="center">
    <app-avatar size="xs"></app-avatar>
    <app-avatar size="sm"></app-avatar>
    <app-avatar size="md"></app-avatar>
    <app-avatar size="lg"></app-avatar>
    <app-avatar size="xl"></app-avatar>
    <app-avatar size="2xl"></app-avatar>
  </app-row>
  <app-row gap="md" wrap align="center">
    <app-avatar size="xs" initials="AJ"></app-avatar>
    <app-avatar size="sm" initials="AJ"></app-avatar>
    <app-avatar size="md" initials="AJ"></app-avatar>
    <app-avatar size="lg" initials="AJ"></app-avatar>
    <app-avatar size="xl" initials="AJ"></app-avatar>
    <app-avatar size="2xl" initials="AJ"></app-avatar>
  </app-row>
  <span class="demo-note">Avatar Label \u2014 no description, so the line centres</span>
  <app-avatar size="lg" description="name@email.com"></app-avatar>
  <app-avatar size="lg" filled label="Label" description="name@email.com"></app-avatar>
  <app-avatar size="lg" filled state="hover" label="Label" description="name@email.com"></app-avatar>
  <app-avatar size="lg" disabled label="Label" description="name@email.com"></app-avatar>
</app-stack>`,
  },
  {
    group: 'Data display',
    tag: 'app-badge',
    blurb: 'Inline status label, five variants.',
    demo: `<app-row gap="sm" wrap>
  <app-badge>neutral</app-badge>
  <app-badge variant="success">success</app-badge>
  <app-badge variant="warning">warning</app-badge>
  <app-badge variant="error">error</app-badge>
  <app-badge variant="info">info</app-badge>
</app-row>`,
  },
  {
    group: 'Data display',
    tag: 'app-tag',
    blurb: 'Figma\u2019s Tag (234:7316) \u2014 State \u00d7 Size, squared not pill. One component for all three usages: display label, selectable filter, and removable input chip. Optional leading stroke icon (an svg child) or circular leading image for provider/model logos. Not a badge \u2014 badges are read-only tonal pills.',
    demo: `<app-stack gap="md" align="start">
  <app-row gap="sm" wrap align="center">
    <app-tag>Default</app-tag>
    <app-tag state="hover">Hover</app-tag>
    <app-tag state="focus">Focus</app-tag>
    <app-tag selected>Selected</app-tag>
    <app-tag disabled>Disabled</app-tag>
  </app-row>
  <app-row gap="sm" wrap align="center">
    <app-tag size="sm">Default</app-tag>
    <app-tag size="sm" state="hover">Hover</app-tag>
    <app-tag size="sm" state="focus">Focus</app-tag>
    <app-tag size="sm" selected>Selected</app-tag>
    <app-tag size="sm" disabled>Disabled</app-tag>
  </app-row>
  <span class="demo-note">Display \u2014 read-only labels</span>
  <app-row gap="sm" wrap align="center">
    <app-tag>Repository review</app-tag>
    <app-tag>Development</app-tag>
    <app-tag>${icons.sparkles()}With icon</app-tag>
  </app-row>
  <span class="demo-note">Filter \u2014 selectable, toggles on click / Enter / Space</span>
  <app-row gap="sm" wrap align="center">
    <app-tag selectable selected>Active</app-tag>
    <app-tag selectable>Beta</app-tag>
    <app-tag selectable disabled>Archived</app-tag>
  </app-row>
  <span class="demo-note">Removable \u2014 the \u00d7 fires tag-remove and drops the chip</span>
  <app-row gap="sm" wrap align="center">
    <app-tag removable image="/common/mark-nasiko.svg">design-system.fig</app-tag>
    <app-tag removable size="sm" image="/common/mark-nasiko.svg">file.jpg</app-tag>
  </app-row>
  <span class="demo-note">Cluster \u2014 as used on agent cards, with a +N overflow chip</span>
  <app-row gap="sm" wrap align="center">
    <app-tag size="sm">Repository review</app-tag>
    <app-tag size="sm">Development</app-tag>
    <app-tag size="sm">+6</app-tag>
  </app-row>
</app-stack>`,
  },
  {
    group: 'Data display',
    tag: 'app-card',
    blurb: 'THE card \u2014 the only one. Status dot, version, tag chips with +N overflow, two-line description, and either the default Details/Chat footer or a slotted one. Status dot carries the state. Deploying shows a spinner with its own copy; error, stopped and loading states included.',
    demo: `<app-grid min-width="300px" gap="md">
  <app-card agent-id="a1" name="Document analyzer" version="1.1.0" status="running"
    description="Provides code structure, documentation quality, dependencies, and summarizes repo functionality."
    tags='["analysis","python","rag"]'></app-card>
  <app-card agent-id="a2" name="Billing agent" version="2.0.1" status="error"
    description="Reconciles invoices against usage records and flags anomalies."
    tags='["finops","node"]'></app-card>
  <app-card agent-id="a3" name="fabric-agent" version="1.0.0" status="deploying"></app-card>
  <app-card agent-id="a4" name="devops-agent" version="0.3.1" status="stopped"
    description="Infrastructure automation, CI/CD pipelines, and deployments."
    tags='["devops","kubernetes"]'></app-card>
  <app-card name="stale-agent" version="0.9.0" status="failed"
    error-title="Agent failed" error-body="Container exited with an error."
    tags='[{"label":"a2a"}]'>
    <app-button slot="footer" variant="tertiary" size="sm" href="/flows">View logs</app-button>
    <app-button slot="footer" variant="primary" size="sm" href="/agents">Redeploy</app-button>
  </app-card>
  <app-card loading></app-card>
</app-grid>`,
  },
  {
    group: 'Data display',
    tag: 'app-stat-card',
    blurb: 'Label + value + delta + trend. Skeletons on [loading].',
    demo: `<app-grid min-width="180px" gap="md">
  <app-stat-card label="Requests" value="18,204" delta="+12%" trend="up"></app-stat-card>
  <app-stat-card label="Spend" value="$412.90" delta="-4%" trend="down"></app-stat-card>
  <app-stat-card label="p95 latency" value="840ms" delta="0%" trend="neutral"></app-stat-card>
  <app-stat-card label="Loading" loading></app-stat-card>
</app-grid>`,
  },
  {
    group: 'Data display',
    tag: 'app-stat-row',
    blurb: 'The page-header metric strip: hairline-separated columns, one row of '
      + 'headline numbers. Takes the whole row as JSON \u2014 optional `sub` caption '
      + 'and `pct` for a severity meter. `loading="n"` reserves n skeleton cells. '
      + 'No per-metric colour: every value in every strip looks the same.',
    demo: `<app-stack gap="lg">
  <app-stat-row items='[
    {"label":"Total cost","value":"$0.000","sub":"Based on 0 operations"},
    {"label":"Total tokens","value":"0","sub":"Across all agents"},
    {"label":"Total operations","value":"0","sub":"0 in the last 24 hours"},
    {"label":"Active agents","value":"0","sub":"16 configured \u00b7 4402.3 agent hrs"}]'></app-stat-row>
  <app-stat-row items='[
    {"label":"CPU in use","value":"2%","sub":"3.2% of 2 cores","pct":2},
    {"label":"Memory in use","value":"43%","sub":"1.6 GB of 3.7 GB","pct":43},
    {"label":"Disk in use","value":"78%","sub":"34 GB of 44 GB","pct":78},
    {"label":"Swap","value":"95%","sub":"1.9 GB of 2.0 GB","pct":95}]'></app-stat-row>
  <span class="demo-note">pct draws the meter \u2014 ok / warn (70) / crit (90).</span>
  <app-stat-row items='[
    {"label":"Router configs","value":"1"},
    {"label":"Providers connected","value":"1"},
    {"label":"Default config","value":"testing"}]'></app-stat-row>
  <app-stat-row loading="4"></app-stat-row>
</app-stack>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'The one chart component \u2014 five forms behind one API. line / bar / donut draw with Chart.js on a canvas; hbar (ranked) and progress are HTML rows, because those two are tables with a magnitude column and their labels and values belong in real text. Series colours are the fixed --viz-1\u20266 scale, never cycled.',
    demo: `<app-stack gap="md">
  <app-chart id="ds-chart-line" type="line" format="currency" height="180px"
    label="Total spend by month"></app-chart>
  <span class="demo-note">line \u2014 two series, so the legend appears on its own.</span>
</app-stack>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'type="bar" with [stacked]. Adjacent and stacked fills carry a 2px surface-coloured border, which is what keeps a stack from reading as one mass.',
    demo: `<app-chart id="ds-chart-bar" type="bar" stacked format="compact" height="180px"
  label="Spend by model"></app-chart>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'type="donut" \u2014 center-value/center-label fill the hole; the legend is always on, since a slice cannot be direct-labelled.',
    demo: `<app-chart id="ds-chart-donut" type="donut" format="percent" height="180px"
  center-value="$11.4k" center-label="total" label="Spend by model"></app-chart>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'TokenOps "Spend over time": a dataset with anomalies: [indices] gets status-red markers and bands (never a series colour \u2014 an anomaly is a state); a dataset with axis: "y2" binds to the right-hand scale, formatted by format-y2. Hovering draws the crosshair. Use y2 reluctantly \u2014 two scales invite reading a crossing the scale ratio invented.',
    demo: `<app-chart id="ds-chart-anomaly-line" type="line" format="currency" format-y2="compact"
  height="200px" label="Spend over time with anomalies"></app-chart>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'TokenOps "Spend concentration": [segmented] draws each stack segment as a gapped pill and hides the y-axis; [average-line] adds the dashed mean-of-column-totals rule. One column per hour, colour per agent from the fixed --viz scale.',
    demo: `<app-chart id="ds-chart-concentration" type="bar" segmented average-line legend="off"
  height="200px" label="Spend concentration by hour"></app-chart>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'type="hbar" \u2014 one measure ranked. Every row shares slot 1: varying the hue would encode a difference that is not there. delta + trend add the trailing change column.',
    demo: `<app-chart id="ds-chart-hbar" type="hbar" label="Spend by model"></app-chart>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'type="progress" \u2014 meters against a fixed 100, one slot per row. Ticked rather than solid, which also gives the rows a non-colour encoding.',
    demo: `<app-chart id="ds-chart-progress" type="progress" label="Quota usage"></app-chart>`,
  },
  {
    group: 'Data display',
    tag: 'app-chart',
    blurb: 'Empty and loading states.',
    demo: `<app-row gap="md">
  <app-chart type="hbar" empty-text="No spend recorded yet"></app-chart>
  <app-chart loading></app-chart>
</app-row>`,
  },
  {
    group: 'Data display',
    tag: 'app-table',
    blurb: 'Paginated data table \u2014 search, sortable columns (auto-detected or declared), skeleton rows, an optional row-detail modal, and numbered page navigation. Rows come from a data source named in data-fn, or from a dataFn assigned directly as the two demos below do. Pagination is optional: pagination="none" renders whatever the fetcher returns, with no pager.',
    demo: `<app-stack gap="md">
  <app-table id="ds-table" search search-placeholder="Filter agents\u2026" limit="5" detail
    empty-message="No agents deployed yet"></app-table>
  <span class="demo-note">Click a header to sort, a row for its detail panel, a page number to jump.</span>
  <app-table id="ds-table-flat" pagination="none" limit="4"></app-table>
  <span class="demo-note">pagination="none" \u2014 the same table with no pager.</span>
</app-stack>`,
  },
  {
    group: 'Data display',
    tag: 'app-code-snippet',
    blurb: 'Labeled command well with a copy button.',
    demo: `<app-code-snippet label="Deploy the agent"
  code="nasiko deploy research-agent --replicas 2"></app-code-snippet>`,
  },

  // ── State & feedback ────────────────────────────────────────────────────
  {
    group: 'State & feedback',
    tag: 'app-empty-state',
    blurb: 'Zero-content placeholder. Default slot takes the action.',
    demo: `<app-empty-state title="No agents yet"
  description="Deploy your first agent to see it here."
  icon='${escAttr(icons.bot('', 32))}'>
  <app-button>Add agent</app-button>
</app-empty-state>`,
  },
  {
    group: 'State & feedback',
    tag: 'app-skeleton',
    blurb: 'Shimmer placeholder. lines / height / radius.',
    demo: `<app-skeleton lines="4"></app-skeleton>`,
  },
  {
    group: 'State & feedback',
    tag: 'app-loading-bar',
    blurb: 'Fixed 3px bar at the viewport top, driven by loading-start / loading-end on document. Mounted once per document (in the page HTML), never inside a page component \u2014 it is a viewport-fixed singleton. The dark strip below is the exception that proves it: a transformed wrapper becomes the containing block for position:fixed, so a real second instance renders in place.',
    demo: `<app-row gap="sm" align="center">
  <app-button variant="secondary" data-demo="loading">Simulate a 1.5s load</app-button>
  <span class="demo-note">Fires at the very top of the window \u2014 and in this strip, a real second instance.</span>
</app-row>
<div class="lb-stage"><app-loading-bar></app-loading-bar></div>`,
  },
  {
    group: 'State & feedback',
    tag: 'toast',
    blurb: 'Figma’s Toast (752:17346) — five types (loading, info, success, warning, error) with an optional description, up to two action buttons and a close button. Not a custom element: a singleton manager imported from common/utils/toast.js, so platform code can reach it without an upward import. Every call returns { close() }; loading is persistent by default.',
    demo: `<app-row gap="sm" wrap align="center">
  <app-button variant="secondary" data-demo="toast-loading">loading</app-button>
  <app-button variant="secondary" data-demo="toast-info">info</app-button>
  <app-button variant="secondary" data-demo="toast-success">success</app-button>
  <app-button variant="secondary" data-demo="toast-warning">warning</app-button>
  <app-button variant="secondary" data-demo="toast-error">error</app-button>
  <app-button variant="secondary" data-demo="toast-rich">description + actions</app-button>
  <app-button data-demo="toast-all">Show all five</app-button>
  <span class="demo-note">Bottom-right of the window. Loading stays until dismissed.</span>
</app-row>`,
  },
];

const GROUPS = [...new Set(SPECS.map((s) => s.group))];

class DesignSystemPage extends HTMLElement {
  #initialized = false;
  #timer = null;

  connectedCallback() {
    if (this.#initialized) return;
    this.#initialized = true;

    this.innerHTML = `
      <div class="page-head">
        <div>
          <h1 class="title-page">Design system</h1>
          <p class="page-sub">
            ${SPECS.length} components in <code>common/design-system/</code>, live.
            Attribute-level docs are in each component's JSDoc header.
          </p>
        </div>
      </div>
      ${GROUPS.map((g) => this.#section(g)).join('')}
    `;

    this.#wire();
  }

  disconnectedCallback() {
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  #section(group) {
    const rows = SPECS.filter((s) => s.group === group).map((s) => `
      <article class="spec">
        <header class="spec-head">
          <h3 class="spec-tag">&lt;${s.tag}&gt;</h3>
          <p class="spec-blurb">${s.blurb}</p>
        </header>
        <div class="spec-demo">${s.demo}</div>
        <details class="spec-src">
          <summary>Markup</summary>
          <app-code-snippet code="${escAttr(s.demo)}"></app-code-snippet>
        </details>
      </article>`).join('');

    return `
      <section class="group">
        <h2 class="group-title">${group}</h2>
        ${rows}
      </section>`;
  }

  /** The handful of demos that need JS: the modal's two forms, the toasts, the loading bar. */
  #wire() {
    const modal = this.querySelector('#ds-demo-modal');
    this.querySelector('[data-demo="open-modal"]')
      ?.addEventListener('click', () => modal?.open());
    for (const btn of this.querySelectorAll('[data-demo="close-modal"]')) {
      btn.addEventListener('click', () => modal?.close());
    }

    // Both tables get their columns and fetcher here rather than in markup:
    // `columns` and `dataFn` are properties, and there is no data-source
    // registry on this page to name.
    for (const id of ['#ds-table', '#ds-table-flat']) {
      const table = this.querySelector(id);
      if (!table) continue;
      table.columns = DS_TABLE_COLUMNS;
      table.dataFn = dsTableFetch;
      table.refresh();
    }

    // `data` is a property on <app-chart>, so the demos cannot declare it in
    // markup the way the attribute-driven components can.
    for (const [id, data] of Object.entries(DS_CHART_DATA)) {
      const chart = this.querySelector(`#${id}`);
      if (chart) chart.data = data;
    }

    const out = this.querySelector('[data-demo="confirm-out"]');
    this.querySelector('[data-demo="confirm"]')?.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: 'Delete agent?',
        message: 'This destroys the container and its logs. This cannot be undone.',
        confirmLabel: 'Delete',
        danger: true,
      });
      if (out) out.textContent = ok ? 'resolved true' : 'resolved false';
    });

    const TOAST_KINDS = ['loading', 'info', 'success', 'warning', 'error'];
    for (const kind of TOAST_KINDS) {
      this.querySelector(`[data-demo="toast-${kind}"]`)?.addEventListener(
        'click', () => toast[kind]('Uploading Your File'));
    }

    this.querySelector('[data-demo="toast-rich"]')?.addEventListener('click', () => {
      toast.info({
        title: 'Uploading Your File',
        description: 'Supporting detail goes here.',
        actions: [{ label: 'Primary' }, { label: 'Secondary', variant: 'secondary' }],
        duration: 0,
      });
    });

    // One click for the whole matrix — the Figma sheet shows all five stacked.
    this.querySelector('[data-demo="toast-all"]')?.addEventListener('click', () => {
      for (const kind of TOAST_KINDS) {
        toast[kind]({
          title: 'Uploading Your File',
          description: 'Supporting detail goes here.',
          actions: [{ label: 'Primary' }, { label: 'Secondary', variant: 'secondary' }],
          duration: 0,
        });
      }
    });

    // The composer disables itself on submit and waits for its owner to release
    // it, exactly as the chat pages do — so the demo has to play that owner.
    // Delegated, so both composers in the demo are covered by one handler.
    const chatboxOut = this.querySelector('[data-demo="chatbox-out"]');
    this.addEventListener('chatbox-submit', (e) => {
      const { value, files } = e.detail;
      if (chatboxOut) {
        chatboxOut.textContent = `submitted: ${JSON.stringify(value)}`
          + (files.length ? ` + ${files.length} file(s): ${files.map((f) => f.name).join(', ')}` : '');
      }
      e.target.reset();
      e.target.setLoading(false);
    });

    this.querySelector('[data-demo="loading"]')?.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('loading-start', { bubbles: true }));
      clearTimeout(this.#timer);
      this.#timer = setTimeout(
        () => document.dispatchEvent(new CustomEvent('loading-end', { bubbles: true })),
        1500,
      );
    });
  }
}

customElements.define('design-system-page', DesignSystemPage);
