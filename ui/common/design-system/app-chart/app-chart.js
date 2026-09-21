/**
 * `<app-chart>` — the one chart component. Five forms, one API.
 *
 * The five forms are the five panels the design specifies, and they are one
 * element rather than five because the thing that varies between them is the
 * *mark*, not the contract: every one takes a series, a format, and a colour
 * slot, and every one has to answer the same accessibility and theming
 * questions. Five components would have meant five copies of the token
 * resolution, the theme subscription, the empty state and the data table.
 *
 * Two of them are not canvas, deliberately:
 *
 *   line · bar · donut   → Chart.js on a <canvas> (vendor/chart.esm.js)
 *   hbar · progress      → HTML rows
 *
 * `hbar` (a ranked list: label, bar, value, delta) and `progress` (label,
 * meter, percentage) are *tables with a magnitude column*, not plots. Chart.js
 * can draw the bars, but the label and value columns would become canvas text —
 * unselectable, unreadable to a screen reader, immune to the type tokens, and
 * needing a custom plugin to lay out at all. As HTML they are ~30 lines of grid,
 * they inherit the type scale, and they are accessible for free. The `type`
 * attribute is the only place a caller sees the difference.
 *
 * ## Colour
 *
 * Series colours come from `--viz-1…7` in tokens/colors.css, assigned in fixed
 * order and never cycled: colour follows the entity, so filtering out series 2
 * must not repaint series 3. An 8th series is NOT given a generated hue — it
 * falls back to `--fg-secondary`, the "Other" slot.
 *
 * Five is the honest ceiling for one chart, not seven. The scale is pastel, and
 * past five slots adjacent pairs start colliding — at six, green/orange sit at
 * ΔE 6.6 under deuteranopia (survivable only because every mark here carries a
 * direct label); at seven, orange/red are ΔE 9.3 in *normal* vision, which no
 * reordering fixes. Beyond five series, group the tail into "Other" or split
 * into small multiples. See the note on --viz-1 for the full measurements.
 *
 * Tokens are read through `getComputedStyle` at render, because Chart.js paints
 * into a canvas and a canvas cannot resolve `var()`. That is also why the
 * element re-renders on theme change: the series scale is theme-independent,
 * but the grid, tick and surface colours it is drawn against are not.
 *
 * ## Accessibility
 *
 * A canvas is opaque to assistive tech, so every canvas form also emits a
 * visually-hidden `<table>` of the same numbers and marks the canvas
 * `role="img"`. The two HTML forms are already text and get no duplicate.
 * Charts with two or more series always render a legend; a single series does
 * not, because the panel title already names it.
 *
 * ## The TokenOps capabilities
 *
 * Three opt-ins added for the TokenOps panels, all inside the same five forms:
 *
 * - **Anomalies** (line): a dataset may carry `anomalies: [index | { index,
 *   note }]`; each flagged point gets a status-red marker with a 2px surface
 *   ring and an 8px alpha-gradient band falling from the point to the
 *   baseline. A `note` ("DevOps Engineer spend 55M tokens") rides into the
 *   tooltip for that index. Red here is the *status* palette, never a series
 *   slot — an anomaly is a state, not an eighth series. Flagged cells also say
 *   "(anomaly)" in the screen-reader table, so the signal is not colour-alone.
 * - **Secondary axis** (line): a dataset may carry `axis: 'y2'` to bind to a
 *   right-hand scale, formatted by `format-y2`. Use it reluctantly: two
 *   y-scales invite reading a crossing that the arbitrary scale ratio
 *   invented. Prefer two stacked charts or indexing to a common base when the
 *   page allows; this exists because the TokenOps design pairs cost with token
 *   volume on one panel.
 * - **Segmented columns** (bar): `segmented` draws each stack segment as a
 *   gapped pill — the "spend concentration" presentation. It implies `stacked`,
 *   hides the y-axis (the shape and the reference line are the reading), and
 *   pairs with `average-line`, a dashed mean-of-column-totals rule.
 *
 * Hovering a line plot also draws a crosshair at the active index — the
 * tooltip says the values, the crosshair says where.
 *
 * @element app-chart
 * @attr {string} type - `line` | `bar` | `donut` | `hbar` | `progress` (default `line`)
 * @attr {boolean} stacked - `bar` only: stack datasets instead of grouping them
 * @attr {string} height - Plot height, any CSS length (default `200px`). Canvas forms only.
 *   A floor, not a fixed size: when the host is laid out taller (a flex panel
 *   that runs to its floor), the plot, skeleton and empty state fill it.
 * @attr {string} format - Value formatting: `number` (default) | `currency` | `percent` |
 *   `compact` | `tokens` | `duration` (milliseconds in, `420ms` / `1.8s` out — for a
 *   latency axis). `tokens` is an alias for `compact` and exists for one reason:
 *   AppStatCard and AppStatRow accept it, so a surface writes `format: "tokens"`
 *   on the token KPI and then, one line later, on the chart of the same numbers —
 *   and got a fatal for being consistent. Two vocabularies for one idea is our
 *   defect, not the caller's. The stat formats this still does NOT take are the
 *   ones an axis cannot mean: `bytes` (no source in scope returns any) and
 *   `date`/`time`/`datetime`/`text`, which are not magnitudes.
 * @attr {string} currency - ISO code for `format="currency"` (default `USD`)
 * @attr {string} center-value - `donut` only: the figure drawn in the hole
 * @attr {string} center-label - `donut` only: the caption under it
 * @attr {string} legend - `auto` (default: on for donut and for 2+ series) | `on` | `off`
 * @attr {string} empty-text - Shown when `data` is empty (default "No data")
 * @attr {boolean} loading - Shimmer placeholder instead of the plot
 * @attr {string} label - Accessible name for the plot. Falls back to the type.
 *   (The four attributes below were added after the catalog first shipped and sit
 *   last on purpose: the DSL passes attributes positionally in @attr order, so a
 *   new one must append — see catalog-compat.mjs.)
 * @attr {boolean} segmented - `bar` only: the concentration presentation — every
 *   stack segment is a gapped, fully-rounded pill, the y-axis is hidden, and
 *   `stacked` is implied. Pair with `average-line` for the reference rule.
 * @attr {boolean} average-line - `bar` only: dashed horizontal rule at the mean
 *   of the column totals, labelled "avg".
 * @attr {string} format-y2 - Right-axis formatting when a dataset declares `axis: 'y2'`:
 *   `number` (default) | `currency` | `percent` | `compact` | `tokens` | `duration`
 * @attr {boolean} flush-top - The plot's own canvas-painted background (see
 *   `plotBackground`) normally rounds all four corners, like any other
 *   surface card. Set this when another element sits directly above the
 *   chart with no gap (the day grid on the concentration panel) and the two
 *   should read as one continuous card: it squares the top two corners off,
 *   leaving only the bottom two rounded. Applies to the loading skeleton and
 *   empty state too (app-chart.css) — those are plain divs shown instead of
 *   the canvas, not something `plotBackground` paints, so they need their
 *   own override rather than inheriting this one.
 * @attr {string} error - The fetch failed. Present (bare, or with a message
 *   overriding the default copy) swaps the plot for the shared inline
 *   failure block — icon, one line, Retry — instead of leaving the skeleton
 *   spinning forever or, worse, showing the empty-state copy, which tells the
 *   user their data does not exist when in truth we could not ask.
 *   `loading` wins over it; it wins over empty.
 * @fires chart-retry - Retry pressed on the failure state — bubbles. The chart
 *   is handed its data, so it cannot refetch; the owner listens and reloads.
 * @prop {object|Array} data - Canvas forms take Chart.js shape:
 *   `{ labels: string[], datasets: [{ label, data }] }`, where a dataset may
 *   also carry `axis: 'y2'` (bind to the right-hand scale — line only),
 *   `anomalies: [index | { index, note }]` (status-red markers + falling
 *   bands at those points; a note rides into the tooltip), and `other: true`
 *   (bar/line — force this dataset onto the grey "Other" slot instead of its
 *   positional `--viz-N` colour; for a segmented bar's overflow bucket, which
 *   must read as "everything else" regardless of which index it lands on).
 *   Row forms take
 *   `[{ label, value, display, delta, trend }]`, where `value` is the magnitude
 *   (percent for `progress`), `display` an optional pre-formatted string, and
 *   `delta` the trailing change string, arrow included. `trend` colours that
 *   delta and is the *sentiment*, not the direction — `up` is green, `down` is
 *   red, matching `app-stat-card`. Rising spend is therefore
 *   `{ delta: '\u219112%', trend: 'down' }`: the arrow says which way the number
 *   moved, `trend` says whether that is good news.
 * @note X-axis labels that are all ISO-8601 are rendered as local dates or
 *   times — clock times within a single day, dates across a longer span. A
 *   label set with any non-date in it is left exactly as given.
 * @fires — none.
 */
import { Chart } from '../../vendor/chart.esm.js';
import { escHtml, escAttr } from '../../utils/escape.js';
import { onThemeChange } from '../../utils/theme.js';
import { timeAxisLabels } from '../../utils/units.js';
import { loadCss } from '/common/utils/css.js';
import { errorStateHtml, bindRetry } from '../app-empty-state/error-state.js';
import '../app-button/app-button.js';
import '../app-empty-state/app-empty-state.js';
const styles = await loadCss(new URL('./app-chart.css', import.meta.url));

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

/** Canvas forms. Everything else renders as HTML rows. */
const CANVAS_TYPES = new Set(['line', 'bar', 'donut']);

/** How many `--viz-*` slots exist. An 8th series folds into the "Other" grey. */
const SERIES_SLOTS = 7;

/**
 * Resolve the design tokens a canvas needs into concrete values.
 *
 * Read per render, not once: the chrome tokens are `light-dark()` pairs and a
 * canvas keeps whatever it was painted with — which is also why this element
 * re-renders on theme change instead of letting CSS do the switching.
 *
 * The resolution goes through a throwaway probe element rather than
 * `getComputedStyle(el).getPropertyValue('--border-primary')`. Reading a custom
 * property directly gives back its *token stream* —
 * `light-dark(#D4CCC0, #3A3D40)`, both branches, unresolved — because an
 * unregistered custom property has no syntax to compute against. Chart.js fails
 * to parse that and silently paints black. Assigning the token to a real
 * property and reading *that* back forces the cascade to pick a branch, so what
 * comes out is an `rgb()`. The series tokens resolve to a plain hex either way;
 * they go through the same path so there is one rule, not two.
 */
function palette(el) {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
  el.appendChild(probe);

  const color = (token) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };

  // body/tertiary (12/16) — the axis-label style the design specifies. Fixed
  // rather than --font-size-xs, which is a clamp that dips below 12px at
  // narrow widths.
  probe.style.fontFamily = 'var(--font-sans)';
  probe.style.fontSize = 'var(--font-size-tertiary)';
  const cs = getComputedStyle(probe);
  const font = cs.fontFamily;
  const fontSize = parseFloat(cs.fontSize) || 12;

  const pal = {
    series: Array.from({ length: SERIES_SLOTS }, (_, i) => color(`--viz-${i + 1}`)),
    other: color('--fg-secondary'),
    grid: color('--border-primary'),
    // chart/axis/label — the design's own token for tick and legend ink.
    tick: color('--chart-axis-label'),
    surface: color('--bg-surface'),
    // The plot rectangle's own fill: the panel around a chart may be tinted,
    // the plot itself sits on base so the marks read against a clean ground.
    base: color('--bg-base'),
    // Status red, for anomaly marks. Deliberately NOT a --viz-* slot: an
    // anomaly is a state, and status colours are never handed out as series.
    error: color('--fg-error'),
    // Primary ink, for the hover overpaint on pills — dark ink in light mode,
    // light ink in dark, so "more contrast" holds in both themes.
    ink: color('--fg-primary'),
    font,
    fontSize,
  };
  probe.remove();
  return pal;
}

/**
 * Keep the donut's centre figure over the *hole*, not over the element.
 *
 * A right-hand legend takes width out of `chartArea`, so the ring is drawn left
 * of the element's centre — an `inset: 0` overlay lands on the arc instead of in
 * the hole. Chart.js only knows the plot rectangle once layout has run, which is
 * what this hooks.
 */
const centreInHole = {
  id: 'app-chart-centre',
  afterLayout(chart) {
    const box = chart.canvas.parentElement?.querySelector('.chart-center');
    if (!box) return;
    const { left, top, right, bottom } = chart.chartArea;
    box.style.left = `${left}px`;
    box.style.top = `${top}px`;
    box.style.width = `${right - left}px`;
    box.style.height = `${bottom - top}px`;
  },
};

/** Fixed-order slot assignment. Past the last slot everything is "Other". */
// A dataset may force the grey "Other" slot regardless of its index
// (`other: true`) — the segmented bar's overflow bucket needs that slot
// at position 4 or 5, not position 8, so index alone cannot express it.
const slot = (pal, i, forceOther) => (forceOther ? pal.other : i < SERIES_SLOTS ? pal.series[i] : pal.other);

/**
 * Paint the whole canvas on --bg-base, whatever surface the panel sits on.
 * The full canvas, not just the plot rectangle: the design's white ground
 * runs under the tick labels and axis captions too, and a base-coloured plot
 * inside surface-coloured margins read as a patch.
 */
const plotBackground = {
  id: 'appChartPlotBg',
  beforeDraw(chart, _args, opts) {
    const { ctx } = chart;
    ctx.save();
    ctx.fillStyle = opts.color;
    ctx.beginPath();
    // 8px corners (the --r-8 step): the ground is a surface card, and it
    // takes the same radius every other card in the system does — all four,
    // UNLESS `flush-top` says another card sits directly above this one (the
    // day grid, for the concentration panel): then the top corners draw
    // square so the two read as one continuous card with no seam, and only
    // the bottom two stay rounded.
    ctx.roundRect(0, 0, chart.width, chart.height, opts.flushTop ? [0, 0, 8, 8] : 8);
    ctx.fill();
    ctx.restore();
  },
};

/** `anomalies` entries may be bare indices or `{ index, note }`. One shape out. */
function normAnomalies(ds) {
  if (!Array.isArray(ds.anomalies)) return [];
  return ds.anomalies
    .map((a) => (typeof a === 'number' ? { index: a } : a))
    .filter((a) => a && Number.isInteger(a.index));
}

/** Pixel positions of every anomaly-flagged point on visible datasets. */
function anomalyPoints(chart) {
  const out = [];
  chart.data.datasets.forEach((ds, di) => {
    const meta = chart.getDatasetMeta(di);
    if (meta.hidden) return;
    for (const { index } of normAnomalies(ds)) {
      const el = meta.data?.[index];
      if (el) out.push({ x: el.x, y: el.y });
    }
  });
  return out;
}

/**
 * Anomaly overlays: an 8px band *behind* the marks running from the flagged
 * point DOWN to the baseline — never above it — fading as it falls, and a
 * status-red dot with a 2px surface ring on the point itself. Band behind,
 * dot in front: the band is context, the dot is the datum. Driven by
 * `anomalies: [index | { index, note }]` on a dataset; the same flags are
 * spelled out as "(anomaly)" in the sr-only table, so a screen reader gets
 * the signal the colour carries, and a note travels into the tooltip.
 */
const anomalyOverlay = {
  id: 'appChartAnomalies',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea } = chart;
    for (const { x, y } of anomalyPoints(chart)) {
      ctx.save();
      // Gradient in alpha, not in hue: strongest at the datum, gone at the
      // baseline, so the band points at its dot instead of striping the plot.
      const g = ctx.createLinearGradient(0, y, 0, chartArea.bottom);
      g.addColorStop(0, colorWithAlpha(opts.color, 0.28));
      g.addColorStop(1, colorWithAlpha(opts.color, 0.03));
      ctx.fillStyle = g;
      ctx.fillRect(x - 4, y, 8, chartArea.bottom - y);
      ctx.restore();
    }
  },
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx } = chart;
    for (const { x, y } of anomalyPoints(chart)) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = opts.color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = opts.surface;
      ctx.stroke();
      ctx.restore();
    }
  },
};

/**
 * The smallest "nice" tick step ≥ raw. The candidate list is wider than the
 * classic 1/2/5 so a series whose max falls just past a step (8.1M across 3
 * rows → 2.7M raw) lands on 3M rather than leaping to 5M and leaving the top
 * half of its axis empty.
 */
function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 10]) {
    if (m * mag >= raw) return m * mag;
  }
  return 10 * mag;
}

/** `rgb(a, b, c)` (what the palette probe returns) with an alpha applied. */
function colorWithAlpha(rgb, alpha) {
  const m = rgb.match(/rgba?\(([^)]+)\)/);
  if (!m) return rgb;
  const [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Hover crosshair for the line form: a 1px vertical rule at the active index.
 * The tooltip already says the values; the rule says where on the axis they
 * sit, which matters once the plot is wide and the eye has to travel.
 */
const hoverCrosshair = {
  id: 'appChartCrosshair',
  afterDatasetsDraw(chart, _args, opts) {
    const active = chart.tooltip?.getActiveElements?.() || [];
    if (!active.length) return;
    const { ctx, chartArea } = chart;
    ctx.save();
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(active[0].element.x, chartArea.top);
    ctx.lineTo(active[0].element.x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/**
 * The segmented form's own renderer. The native bars are made transparent and
 * this draws the pills over their geometry: every segment a fully-rounded
 * capsule, a 2px breathing gap between neighbours, and a floor of one full
 * circle so a tiny "Other" share reads as a dot instead of vanishing (the
 * design's floating dots; the honest number is one hover away).
 *
 * Chart.js's own borderRadius was not this: on stacked bars it squares inner
 * corners however it is configured, and faking gaps with a surface-coloured
 * border paints a visible casing the moment the plot background is not the
 * surface colour. Owning the draw ends both fights.
 *
 * Hover: the active column's pills are overpainted with a translucent ink so
 * they darken in place — contrast, not a box around the column.
 */
const pillBars = {
  id: 'appChartPills',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx } = chart;
    const active = new Set((chart.getActiveElements() || []).map((a) => a.index));
    chart.data.datasets.forEach((ds, di) => {
      const meta = chart.getDatasetMeta(di);
      if (meta.hidden) return;
      meta.data.forEach((el, i) => {
        const top = Math.min(el.y, el.base);
        const bottom = Math.max(el.y, el.base);
        if (bottom - top <= 0) return;
        const w = 8;
        // A near-zero segment still needs to read as a dot, not vanish — but
        // the floor must grow UPWARD from this segment's grounded edge
        // (`bottom`: the neighbour below it, or the axis itself for the
        // lowest series), never downward past it. Anchoring at `top` and
        // pushing `height` down instead (the previous approach) drew the
        // lowest series' near-zero hours several px below the actual x-axis
        // — invisible before this form had a baseline to show it against,
        // and wrong regardless once it did.
        const short = bottom - top - 2 < w;
        // 1px shaved off each end = the 2px gap between stacked neighbours;
        // the floored case only has a neighbour above it to gap from.
        const y0 = short ? bottom - w - 1 : top + 1;
        const h = short ? w : bottom - top - 2;
        ctx.save();
        ctx.beginPath();
        ctx.roundRect(el.x - w / 2, y0, w, h, w / 2);
        ctx.fillStyle = ds._slot;
        ctx.fill();
        if (active.has(i)) {
          ctx.fillStyle = opts.hoverInk;
          ctx.fill();
        }
        ctx.restore();
      });
    });
  },
};

/**
 * Dashed mean-of-column-totals rule for the segmented bar form. The mean is
 * over ALL columns, quiet hours included — dropping the zeros would flatter
 * every busy hour by raising the bar it is compared against.
 */
const averageLine = {
  id: 'appChartAverage',
  afterDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea, scales } = chart;
    const labels = chart.data.labels || [];
    if (!labels.length || !scales.y) return;
    const totals = labels.map((_, i) =>
      chart.data.datasets.reduce(
        (t, ds, di) => (chart.getDatasetMeta(di).hidden ? t : t + (Number(ds.data?.[i]) || 0)), 0));
    const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
    const y = scales.y.getPixelForValue(avg);
    if (y < chartArea.top || y > chartArea.bottom) return;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = opts.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = opts.color;
    ctx.font = opts.font;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('avg', chartArea.left, y - 3);
    ctx.restore();
  },
};

/**
 * @param {Element} el
 * @param {string} [attr]
 * @param {{tick?: boolean}} [opts] `tick` when the string labels an AXIS.
 *   An axis tick and a tooltip value are not the same job. A tooltip states
 *   one figure and $0.50 is how a figure of fifty cents is written. A tick
 *   names a position on a scale, and there the second decimal is padding: the
 *   run "$0.50 / $1 / $1.50" pads two of its three labels to a width the
 *   others do not use, and 0.5 is the number. Ticks therefore drop trailing
 *   zeros; everything else keeps the currency's own two.
 * @returns {(n: number) => string}
 */
function formatter(el, attr = 'format', { tick = false } = {}) {
  const kind = el.getAttribute(attr) || 'number';
  const currency = el.getAttribute('currency') || 'USD';
  if (kind === 'currency') {
    // narrowSymbol: "$240", never the locale-dependent "US$240" — the panel
    // header already says which ledger this is.
    const whole = new Intl.NumberFormat(undefined,
      { style: 'currency', currency, currencyDisplay: 'narrowSymbol', maximumFractionDigits: 0 });
    // Below $10 the ticks step in cents; rounding them all to "$0" / "$1" drew a
    // scale of duplicate labels on a near-zero series.
    const cents = new Intl.NumberFormat(undefined,
      { style: 'currency', currency, currencyDisplay: 'narrowSymbol',
        minimumFractionDigits: tick ? 0 : 2, maximumFractionDigits: 2 });
    return (n) => (Math.abs(n) < 10 && n !== Math.round(n) ? cents : whole).format(n);
  }
  if (kind === 'percent') return (n) => `${Math.round(n)}%`;
  // Milliseconds in, the unit a person reads out. A latency axis labelled
  // 1,000 / 2,000 / 3,000 makes the reader do the division on every glance;
  // the same axis labelled 1s / 2s / 3s does not. Sub-second stays in ms
  // because "0.4s" hides a digit the tooltip has room for.
  if (kind === 'duration') {
    return (n) => (Math.abs(n) < 1000
      ? `${Math.round(n)}ms`
      : `${Number((n / 1000).toFixed(1))}s`);
  }
  // `tokens` is `compact` — deliberately the same function, not a near-copy, so
  // the two names cannot drift into rendering the same number differently.
  if (kind === 'compact' || kind === 'tokens') {
    const f = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
    return (n) => f.format(n);
  }
  const f = new Intl.NumberFormat();
  return (n) => f.format(n);
}

export class AppChart extends HTMLElement {
  static get observedAttributes() {
    return ['type', 'stacked', 'segmented', 'average-line', 'height', 'format',
            'format-y2', 'currency', 'center-value',
            'center-label', 'legend', 'empty-text', 'loading', 'label', 'flush-top',
            'error'];
  }

  #initialized = false;
  /** @type {Chart|null} */
  #chart = null;
  /** @type {(() => void)|null} */
  #unsubscribeTheme = null;
  #data = null;

  /** @param {object|Array} next */
  set data(next) {
    this.#data = next;
    if (this.#initialized) this.render();
  }

  get data() { return this.#data; }

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      // Delegated and bound once, before the first render: the button lives
      // inside markup render() replaces wholesale.
      bindRetry(this, 'chart-retry');
      this.render();
    }
    // Subscribed here rather than in the one-time block: teardown runs on every
    // disconnect, so an element that is moved must re-subscribe or it silently
    // stops following the theme.
    this.#unsubscribeTheme = onThemeChange(() => this.render());
  }

  disconnectedCallback() {
    this.#unsubscribeTheme?.();
    this.#unsubscribeTheme = null;
    this.#destroyChart();
  }

  attributeChangedCallback() {
    if (this.isConnected && this.#initialized) this.render();
  }

  #destroyChart() {
    this.#chart?.destroy();
    this.#chart = null;
  }

  #type() {
    const t = this.getAttribute('type') || 'line';
    return ['line', 'bar', 'donut', 'hbar', 'progress'].includes(t) ? t : 'line';
  }

  /** Row forms accept an array; canvas forms a `{labels, datasets}` object. */
  #rows() { return Array.isArray(this.#data) ? this.#data : []; }

  #datasets() {
    const d = this.#data;
    return d && !Array.isArray(d) && Array.isArray(d.datasets) ? d.datasets : [];
  }

  #isEmpty() {
    return CANVAS_TYPES.has(this.#type())
      ? this.#datasets().every((s) => !s.data?.length)
      : this.#rows().length === 0;
  }

  /**
   * Loading placeholder for the column forms (bar/donut). A row of bars with
   * varied heights — each its own element, each pulsing on its own timing —
   * reads as "a chart is coming" instead of one flat rectangle that could be
   * standing in for anything.
   *
   * The bar heights are percentages, so the box has to carry a DEFINITE
   * height (see `#skeletonBox`) — a panel that sizes to its content (Overview
   * lays its second row out with `align-items: start`) leaves the slot's
   * height indefinite, percentages resolve to `auto`, and every bar collapses
   * to nothing: a blank white card where the skeleton should be.
   */
  #barsSkeletonHtml(box) {
    const heights = [55, 82, 38, 68, 92, 50, 74];
    const bar = (h, i) => `<div class="chart-skel-bar" style="height:${h}%;animation-delay:${(i * 0.1).toFixed(1)}s"></div>`;
    return `<div class="chart-skeleton" ${box}>${heights.map(bar).join('')}</div>`;
  }

  /**
   * Loading placeholder for `type="line"`. A row of bars is the wrong promise
   * for a chart that resolves into a line, so this draws the line itself —
   * one polyline on a `preserveAspectRatio="none"` viewBox, which stretches to
   * whatever box the slot ends up with and needs no percentage heights at all.
   */
  #lineSkeletonHtml(box) {
    return `<div class="chart-skeleton is-line" ${box}>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
        <polyline points="0,30 14,18 28,24 42,9 57,20 71,6 85,15 100,4" vector-effect="non-scaling-stroke"></polyline>
      </svg>
    </div>`;
  }

  /**
   * The skeleton reserves the plot's box as a DEFINITE height, not a floor:
   * `.chart-skeleton` still grows (`flex: 1`) to fill a stretched panel, but
   * the declared height is what the bar percentages resolve against, so they
   * survive a panel that sizes to its content. The empty state keeps
   * `min-height` — it is centred text that should be free to grow.
   */
  #skeletonBox() {
    return `style="height:${escAttr(this.getAttribute('height') || '200px')}"`;
  }

  /**
   * Loading placeholder for the two row forms (hbar/progress). They are
   * ranked lists, not plots — a label, a track and a value per row — so the
   * placeholder is a few rows in the real `.chart-rows` grid instead of a
   * rectangle shaped like a chart this form never draws.
   */
  #rowsSkeletonHtml() {
    const row = () => `
      <div class="chart-row">
        <span class="chart-row-skel-label"></span>
        <span class="chart-row-track"><span class="chart-row-fill is-skeleton"></span></span>
        <span class="chart-row-skel-value"></span>
      </div>`;
    return `<div class="chart-rows">${Array.from({ length: 4 }, row).join('')}</div>`;
  }

  render() {
    this.#destroyChart();

    // Skeleton and empty state take the same box the plot would, on the same
    // ground, so a panel does not collapse and re-expand as data arrives — and
    // an empty chart still reads as a chart card, not a stray line of text.
    const box = CANVAS_TYPES.has(this.#type()) ? `style="min-height:${escAttr(this.getAttribute('height') || '200px')}"` : '';

    if (this.hasAttribute('loading')) {
      this.setAttribute('aria-busy', 'true');
      const type = this.#type();
      if (!CANVAS_TYPES.has(type)) this.innerHTML = this.#rowsSkeletonHtml();
      else if (type === 'line') this.innerHTML = this.#lineSkeletonHtml(this.#skeletonBox());
      else this.innerHTML = this.#barsSkeletonHtml(this.#skeletonBox());
      return;
    }
    this.removeAttribute('aria-busy');

    // Ordered loading > error > empty > data. Empty last of the three on
    // purpose: a failed request usually leaves `data` empty too, so checking
    // emptiness first would show "No data" for every failure.
    if (this.hasAttribute('error')) {
      const msg = this.getAttribute('error') || "Couldn't load this chart";
      // Same ground and same box as the empty state — `.chart-empty` is the
      // plot-shaped placeholder, not a statement about which placeholder.
      this.innerHTML = `<div class="chart-empty" ${box}>${errorStateHtml(msg)}</div>`;
      return;
    }

    if (this.#isEmpty()) {
      // Through `app-empty-state` rather than a bare `<p>`, so the icon, the
      // measure and the type match the failure block directly above and every
      // other empty state in the product.
      this.innerHTML = `<div class="chart-empty" ${box}>`
        + `<app-empty-state inline description="${escAttr(this.getAttribute('empty-text') || 'No data')}"></app-empty-state>`
        + `</div>`;
      return;
    }

    if (CANVAS_TYPES.has(this.#type())) this.#renderCanvas();
    else this.#renderRows();
  }

  // ── Canvas forms ──────────────────────────────────────────────────────────

  #renderCanvas() {
    const type = this.#type();
    const pal = palette(this);
    const fmt = formatter(this);
    const fmt2 = formatter(this, 'format-y2');
    // Axis ticks get their own pair: same unit, scale spelling. See formatter().
    const tickFmt = formatter(this, 'format', { tick: true });
    const tickFmt2 = formatter(this, 'format-y2', { tick: true });
    const sets = this.#datasets();
    const labels = timeAxisLabels(this.#data.labels || []);
    const showLegend = this.#showLegend(type, sets.length);
    const hasY2 = type === 'line' && sets.some((s) => s.axis === 'y2');
    const segmented = type === 'bar' && this.hasAttribute('segmented');
    const hasAnomalies = sets.some((s) => Array.isArray(s.anomalies) && s.anomalies.length);

    const centerValue = this.getAttribute('center-value');
    const centerLabel = this.getAttribute('center-label');
    const height = this.getAttribute('height') || '200px';

    this.innerHTML = `
      <div class="chart-plot" style="min-height:${escAttr(height)}">
        <canvas role="img" aria-label="${escAttr(this.getAttribute('label') || `${type} chart`)}"></canvas>
        ${type === 'donut' && (centerValue || centerLabel) ? `
          <div class="chart-center" aria-hidden="true">
            ${centerValue ? `<span class="chart-center-value">${escHtml(centerValue)}</span>` : ''}
            ${centerLabel ? `<span class="chart-center-label">${escHtml(centerLabel)}</span>` : ''}
          </div>` : ''}
      </div>
      ${this.#dataTable(labels, sets, fmt, fmt2)}`;

    Chart.defaults.font.family = pal.font;
    Chart.defaults.font.size = pal.fontSize;
    Chart.defaults.color = pal.tick;

    // Per-instance plugins, only the ones this render needs — an inert plugin
    // still runs its hooks on every frame.
    const plugins = [plotBackground];
    if (type === 'donut') plugins.push(centreInHole);
    if (type === 'line') plugins.push(hoverCrosshair);
    if (type === 'line' && hasAnomalies) plugins.push(anomalyOverlay);
    // avg rule before the pills, so the pills cross OVER the reference line.
    if (type === 'bar' && this.hasAttribute('average-line')) plugins.push(averageLine);
    if (segmented) plugins.push(pillBars);

    this.#chart = new Chart(this.querySelector('canvas'), {
      type: type === 'donut' ? 'doughnut' : type,
      data: { labels, datasets: sets.map((s, i) => this.#dataset(type, s, i, pal, segmented)) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // 16px of the card's own ground between its rounded edge and anything
        // drawn — axis labels included. The --s-16 step, as a canvas number.
        // Top is 24, not 16: the topmost tick label centres on the top
        // gridline, so half its 16px line overhangs the plot — 16 + 8 keeps a
        // true 16px of clear ground above the tallest ink.
        // Bottom is 0 when the legend is on: Chart.js pads the legend row with
        // its own `labels.padding` (28, half of it above the row), which already
        // clears the x-axis labels — adding 16 more read as a hole between them.
        layout: { padding: { top: 24, right: 16, bottom: showLegend ? 0 : 16, left: 16 } },
        // Chart.js animates on every re-render, and this element re-renders on
        // theme change — an animated repaint on a theme flip reads as a glitch.
        animation: { duration: 240 },
        interaction: { mode: type === 'donut' ? 'nearest' : 'index', intersect: false },
        plugins: {
          legend: showLegend
            ? { position: type === 'donut' ? 'right' : 'bottom', align: 'start',
                // 28px between the series entries, per the design's legend row.
                labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 28,
                  // The segmented form draws its bars transparent and lets the
                  // pillBars plugin paint from `_slot` — so Chart.js's default
                  // swatch, which reads `backgroundColor`, came out invisible
                  // and the legend was labels with no dots. Read `_slot` here
                  // too. (The concentration panel never hit this because it
                  // sets `legend="off"` and hand-rolls its own row.)
                  ...(segmented ? { generateLabels: (chart) => chart.data.datasets.map((ds, i) => ({
                    text: ds.label,
                    fillStyle: ds._slot,
                    strokeStyle: ds._slot,
                    pointStyle: 'circle',
                    hidden: !chart.isDatasetVisible(i),
                    datasetIndex: i,
                  })) } : {}) } }
            : { display: false },
          // The native canvas tooltip cannot do the design's card — bold date
          // title, label left / value right, an anomaly note line — so it is
          // disabled and an HTML card in the plot box renders instead. HTML
          // also keeps the tooltip in real text: tokens, wrapping, zoom.
          tooltip: { enabled: false, external: (ctx) => this.#htmlTooltip(ctx, { type, fmt, fmt2 }) },
          appChartCrosshair: { color: pal.grid },
          appChartAnomalies: { color: pal.error, surface: pal.surface },
          appChartAverage: { color: pal.tick, font: `${pal.fontSize}px ${pal.font}` },
          appChartPlotBg: { color: pal.base, flushTop: this.hasAttribute('flush-top') },
          appChartPills: { hoverInk: colorWithAlpha(pal.ink, 0.22) },
        },
        scales: type === 'donut' ? {} : this.#scales(pal, tickFmt, tickFmt2, { hasY2, segmented }),
      },
      plugins,
    });
  }

  /**
   * The design's tooltip card, in HTML: bold title, one row per series with
   * the label left and the value right (formatted on that dataset's own axis),
   * a colour dot only where identity needs it (bar/donut — on a line the
   * crosshair and the measure names already say which is which), and any
   * anomaly note for the hovered index as a trailing line. Built with
   * createElement/textContent throughout: labels and notes are data.
   */
  #htmlTooltip(ctx, { type, fmt, fmt2 }) {
    const plot = this.querySelector('.chart-plot');
    if (!plot) return;
    let tip = plot.querySelector('.chart-tooltip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tooltip';
      tip.setAttribute('aria-hidden', 'true'); // the sr table is the AT view
      plot.appendChild(tip);
    }
    const model = ctx.tooltip;
    if (!model || model.opacity === 0 || !model.dataPoints?.length) {
      tip.classList.remove('is-visible');
      return;
    }

    tip.replaceChildren();
    const title = (model.title || []).join(' ');
    if (title) {
      const t = document.createElement('div');
      t.className = 'chart-tooltip-title';
      t.textContent = title;
      tip.appendChild(t);
    }
    for (const dp of model.dataPoints) {
      const row = document.createElement('div');
      row.className = 'chart-tooltip-row';
      if (type !== 'line') {
        const dot = document.createElement('span');
        dot.className = 'chart-tooltip-dot';
        dot.style.background = dp.dataset._slot
          || model.labelColors?.[dp.datasetIndex]?.backgroundColor
          || dp.dataset.borderColor || '';
        row.appendChild(dot);
      }
      const label = document.createElement('span');
      label.className = 'chart-tooltip-label';
      // A donut row names the slice; every other form names the series.
      label.textContent = (type === 'donut' ? dp.label : dp.dataset.label) || 'Series';
      const value = document.createElement('span');
      value.className = 'chart-tooltip-value';
      value.textContent = (dp.dataset.yAxisID === 'y2' ? fmt2 : fmt)(dp.parsed.y ?? dp.parsed);
      row.append(label, value);
      tip.appendChild(row);
    }
    if (type === 'line') {
      const idx = model.dataPoints[0].dataIndex;
      for (const ds of this.#datasets()) {
        for (const a of normAnomalies(ds)) {
          if (a.index === idx && a.note) {
            const note = document.createElement('div');
            note.className = 'chart-tooltip-note';
            note.textContent = a.note;
            tip.appendChild(note);
          }
        }
      }
    }

    // Placement, per the design: beside the point on the right when there is
    // room, otherwise above the topmost active element (a stacked column's
    // top, not the average of its segments) so the card sits clear of the
    // data it describes. Above may extend past the plot's top edge — that is
    // what the design shows, it only overlaps EARLIER content (the panel
    // header), which the later-in-DOM tooltip paints over — but never below,
    // where later page sections would paint over the card. The caret
    // (::after) always points back at the datum.
    tip.classList.add('is-visible');
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const GAP = 14;
    tip.classList.remove('is-right', 'is-above');
    if (model.caretX + GAP + w <= plot.clientWidth - 2) {
      tip.classList.add('is-right');
      tip.style.left = `${model.caretX + GAP}px`;
      // Vertically centred on the point, nudged back inside the plot when the
      // point sits near an edge.
      tip.style.top = `${Math.min(Math.max(model.caretY, h / 2 + 2), plot.clientHeight - h / 2 - 2)}px`;
    } else {
      const anchorY = Math.min(model.caretY,
        ...model.dataPoints.map((dp) => dp.element?.y ?? model.caretY));
      tip.classList.add('is-above');
      tip.style.left = `${Math.min(Math.max(model.caretX, w / 2 + 2), plot.clientWidth - w / 2 - 2)}px`;
      tip.style.top = `${anchorY - GAP + 2}px`;
    }
  }

  #showLegend(type, seriesCount) {
    const mode = this.getAttribute('legend') || 'auto';
    if (mode === 'on') return true;
    if (mode === 'off') return false;
    return type === 'donut' || seriesCount >= 2;
  }

  /**
   * Mark spec, per form. The 2px `borderColor: surface` on the bar and donut
   * families is not decoration — it is the gap that keeps stacked segments and
   * adjacent bars from reading as one continuous mass.
   */
  #dataset(type, s, i, pal, segmented = false) {
    const base = { ...s };
    if (type === 'donut') {
      return {
        ...base,
        backgroundColor: s.data.map((_, j) => slot(pal, j)),
        borderColor: pal.surface,
        borderWidth: 2,
      };
    }
    if (type === 'bar') {
      // Segmented: the concentration presentation. The native bars are drawn
      // fully transparent and only supply geometry + hit areas — the pillBars
      // plugin owns the paint (capsule radius, 2px gaps, hover contrast),
      // because Chart.js squares the inner corners of stacked bars whatever
      // borderRadius says, and a surface-coloured "gap" border reads as a
      // casing once the plot background is base, not surface.
      if (segmented) {
        return {
          ...base,
          _slot: slot(pal, i, s.other),
          backgroundColor: 'transparent',
          borderWidth: 0,
          barThickness: 8,
        };
      }
      return {
        ...base,
        backgroundColor: slot(pal, i, s.other),
        borderColor: pal.surface,
        borderWidth: 2,
        borderRadius: 4,
        borderSkipped: false,
      };
    }
    return {
      ...base,
      // Line only: a dataset may opt onto the right-hand scale.
      ...(s.axis === 'y2' ? { yAxisID: 'y2' } : {}),
      borderColor: slot(pal, i, s.other),
      backgroundColor: slot(pal, i, s.other),
      // 1px strokes per the design — every rule in the plot (series, grid,
      // crosshair, avg) is a hairline.
      borderWidth: 1,
      // Straight segments: a spline invents values between the points it was
      // given, which on a spend or latency series is a lie the reader cannot see.
      tension: 0,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: pal.surface,
    };
  }

  /** `tickFmt`/`tickFmt2` are the AXIS formatters, not the value ones — a tick
   *  names a position on the scale and drops the padding zeros a figure keeps.
   *  See formatter(). */
  #scales(pal, tickFmt, tickFmt2, { hasY2 = false, segmented = false } = {}) {
    // `segmented` implies stacking: the pills ARE the stack segments.
    const stacked = this.hasAttribute('stacked') || segmented;
    const scales = {
      x: {
        stacked,
        // Vertical rules add no information on a categorical or time axis and
        // compete with the marks for attention.
        grid: { display: false },
        // The segmented form hides the y-axis entirely (below), so the x
        // baseline is the only rule left on the plot — it reads as the floor
        // the pills stand on. Every other bar/line form stays borderless,
        // matching the rest of the design system's chrome-light plots.
        border: { display: segmented, color: pal.grid },
        // Segmented plots carry a dense categorical axis (24 hours): thin the
        // ticks rather than rotate them — slanted labels read slower than a
        // sparser run of upright ones.
        ticks: { color: pal.tick, ...(segmented ? { maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } : {}) },
      },
      y: {
        stacked,
        beginAtZero: true,
        // Solid hairline grid — the dash Chart.js inherits from border.dash
        // striped every gridline, and the design's rules are straight.
        grid: { color: pal.grid, drawTicks: false },
        border: { display: false },
        // The design's vertical rhythm: a 16px label line on each rule, 20px
        // of air between — a 36px pitch, so the tick count comes from the
        // plot's height instead of Chart.js's own guess.
        // maxTicksLimit, not count: a hard count forces steps like $90 where
        // the reading wants $100 — the limit keeps the design's pitch while
        // Chart.js still lands on round values.
        ticks: { color: pal.tick, padding: 8, callback: (v) => tickFmt(v),
                 maxTicksLimit: this.#tickCount() },
        // The concentration presentation hides the value axis: the reading is
        // the shape of the day and the position against the avg rule, and per-
        // column numbers stay one hover (or the sr table) away.
        display: !segmented,
      },
    };
    if (hasY2) {
      scales.y2 = {
        position: 'right',
        beginAtZero: true,
        // The left axis owns the horizontal grid; a second grid from a second
        // scale would draw two unrelated rulings over one plot.
        grid: { drawOnChartArea: false, drawTicks: false },
        border: { display: false },
        ticks: { color: pal.tick, padding: 8, callback: (v) => tickFmt2(v) },
        // Two scales, one set of rules: rebuild y2's ticks on the SAME
        // fractional positions as the left axis's gridlines, stretching y2's
        // max to the next nice step so the values stay round. Left to its own
        // devices Chart.js ticks each scale independently, and the right-hand
        // labels float between the rules — the misalignment every dual-axis
        // chart is born with.
        afterBuildTicks: (scale) => {
          const left = scale.chart.scales.y;
          if (!left?.ticks?.length || left.ticks.length < 2) return;
          const rows = left.ticks.length - 1;
          const step = niceStep(scale.max / rows);
          scale.min = 0;
          scale.max = step * rows;
          scale.ticks = Array.from({ length: rows + 1 }, (_, i) => ({ value: step * i }));
        },
      };
    }
    return scales;
  }

  /**
   * How many y ticks a plot of this height carries, from the design's 52px
   * rhythm (a 16px label line + 36px of air). Approximate by intent: the
   * height attribute is the plot box, minus ~28px of x-axis labels below it.
   */
  #tickCount() {
    const h = parseInt(this.getAttribute('height') || '200', 10) || 200;
    return Math.min(8, Math.max(3, Math.round((h - 28) / 52) + 1));
  }

  /**
   * The screen-reader view of a canvas. `.sr-only` in styles/, so it costs no
   * layout; it is the "a table view exists" half of not encoding by colour alone.
   *
   * The `.sr-only` box is the wrapping div, not the table: `height: 1px` and
   * `overflow: hidden` do nothing to a `display: table` box, which sizes to its
   * rows — and an absolutely-positioned 1400px-tall table still counts toward
   * the document's scrollable overflow, which is what gave a 31-day chart a page
   * that scrolled a screen and a half past its own content.
   */
  #dataTable(labels, sets, fmt, fmt2 = fmt) {
    const head = sets.map((s) => `<th scope="col">${escHtml(s.label || 'Series')}</th>`).join('');
    const body = labels.map((l, r) => `
      <tr><th scope="row">${escHtml(String(l))}</th>${
        sets.map((s) => `<td>${escHtml((s.axis === 'y2' ? fmt2 : fmt)(Number(s.data?.[r] ?? 0)))}${
          normAnomalies(s).some((a) => a.index === r) ? ' (anomaly)' : ''}</td>`).join('')
      }</tr>`).join('');
    return `<div class="sr-only"><table>
        <caption>${escHtml(this.getAttribute('label') || 'Chart data')}</caption>
        <thead><tr><th scope="col">Label</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table></div>`;
  }

  // ── Row forms ─────────────────────────────────────────────────────────────

  /**
   * `hbar` and `progress` share this markup and differ only in how the fill is
   * painted (solid vs ticked) and what the trailing column holds. Bars are
   * scaled against the largest value so the ranking is readable; a progress
   * meter is against 100, because a percentage that scaled to its own maximum
   * would make "72% of budget" look full.
   */
  #renderRows() {
    const type = this.#type();
    const rows = this.#rows();
    const fmt = formatter(this);
    const max = type === 'progress' ? 100 : Math.max(...rows.map((r) => Number(r.value) || 0), 1);

    this.innerHTML = `
      <div class="chart-rows is-${type}" role="list">
        ${rows.map((r, i) => {
          const value = Number(r.value) || 0;
          const pct = Math.max(0, Math.min(100, (value / max) * 100));
          const display = r.display ?? (type === 'progress' ? `${Math.round(value)}%` : fmt(value));
          const trend = r.trend === 'up' || r.trend === 'down' ? r.trend : 'neutral';
          // Every row is a single entity, so its colour is its slot index — the
          // same fixed assignment the canvas forms use, and past the last slot
          // the same "Other" grey rather than a cycled hue. `hbar` is one
          // measure ranked, so every row shares slot 1: varying hue there would
          // encode a difference that does not exist.
          const color = type === 'hbar' ? 'var(--viz-1)'
            : i < SERIES_SLOTS ? `var(--viz-${i + 1})` : 'var(--fg-secondary)';
          return `
            <div class="chart-row" role="listitem">
              <span class="chart-row-label">${escHtml(String(r.label ?? ''))}</span>
              <span class="chart-row-track">
                <span class="chart-row-fill" style="width:${pct}%;color:${color}"></span>
              </span>
              <span class="chart-row-value">${escHtml(String(display))}</span>
              ${r.delta ? `<span class="chart-row-delta is-${trend}">${escHtml(String(r.delta))}</span>` : ''}
            </div>`;
        }).join('')}
      </div>`;
  }
}

customElements.define('app-chart', AppChart);
