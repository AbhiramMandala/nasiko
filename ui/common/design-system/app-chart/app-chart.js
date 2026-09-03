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
 * - **Anomalies** (line): a dataset may carry `anomalies: [indices]`; each
 *   flagged point gets a status-red marker with a 2px surface ring and a
 *   translucent vertical band behind the marks. Red here is the *status*
 *   palette, never a series slot — an anomaly is a state, not an eighth series.
 *   Flagged cells also say "(anomaly)" in the screen-reader table, so the
 *   signal is not colour-alone.
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
 * @attr {boolean} segmented - `bar` only: the concentration presentation — every
 *   stack segment is a gapped, fully-rounded pill, the y-axis is hidden, and
 *   `stacked` is implied. Pair with `average-line` for the reference rule.
 * @attr {boolean} average-line - `bar` only: dashed horizontal rule at the mean
 *   of the column totals, labelled "avg".
 * @attr {string} height - Plot height, any CSS length (default `200px`). Canvas forms only.
 * @attr {string} format - Value formatting: `number` (default) | `currency` | `percent` | `compact`
 * @attr {string} format-y2 - Right-axis formatting when a dataset declares `axis: 'y2'`:
 *   `number` (default) | `currency` | `percent` | `compact`
 * @attr {string} currency - ISO code for `format="currency"` (default `USD`)
 * @attr {string} center-value - `donut` only: the figure drawn in the hole
 * @attr {string} center-label - `donut` only: the caption under it
 * @attr {string} legend - `auto` (default: on for donut and for 2+ series) | `on` | `off`
 * @attr {string} empty-text - Shown when `data` is empty (default "No data")
 * @attr {boolean} loading - Shimmer placeholder instead of the plot
 * @attr {string} label - Accessible name for the plot. Falls back to the type.
 * @prop {object|Array} data - Canvas forms take Chart.js shape:
 *   `{ labels: string[], datasets: [{ label, data }] }`, where a dataset may
 *   also carry `axis: 'y2'` (bind to the right-hand scale — line only) and
 *   `anomalies: [indices]` (status-red markers + bands at those points).
 *   Row forms take
 *   `[{ label, value, display, delta, trend }]`, where `value` is the magnitude
 *   (percent for `progress`), `display` an optional pre-formatted string, and
 *   `delta` the trailing change string, arrow included. `trend` colours that
 *   delta and is the *sentiment*, not the direction — `up` is green, `down` is
 *   red, matching `app-stat-card`. Rising spend is therefore
 *   `{ delta: '\u219112%', trend: 'down' }`: the arrow says which way the number
 *   moved, `trend` says whether that is good news.
 * @fires — none.
 */
import { Chart } from '../../vendor/chart.esm.js';
import { escHtml, escAttr } from '../../utils/escape.js';
import { onThemeChange } from '../../utils/theme.js';
import { loadCss } from '/common/utils/css.js';
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

  probe.style.fontFamily = 'var(--font-sans)';
  probe.style.fontSize = 'var(--font-size-xs)';
  const cs = getComputedStyle(probe);
  const font = cs.fontFamily;
  const fontSize = parseFloat(cs.fontSize) || 12;

  const pal = {
    series: Array.from({ length: SERIES_SLOTS }, (_, i) => color(`--viz-${i + 1}`)),
    other: color('--fg-secondary'),
    grid: color('--border-primary'),
    tick: color('--fg-secondary'),
    surface: color('--bg-surface'),
    // Status red, for anomaly marks. Deliberately NOT a --viz-* slot: an
    // anomaly is a state, and status colours are never handed out as series.
    error: color('--fg-error'),
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
const slot = (pal, i) => (i < SERIES_SLOTS ? pal.series[i] : pal.other);

/** Pixel positions of every anomaly-flagged point on visible datasets. */
function anomalyPoints(chart) {
  const out = [];
  chart.data.datasets.forEach((ds, di) => {
    if (!Array.isArray(ds.anomalies)) return;
    const meta = chart.getDatasetMeta(di);
    if (meta.hidden) return;
    for (const idx of ds.anomalies) {
      const el = meta.data?.[idx];
      if (el) out.push({ x: el.x, y: el.y });
    }
  });
  return out;
}

/**
 * Anomaly overlays: a translucent band the full plot height *behind* the marks
 * (before-draw), and a status-red dot with a 2px surface ring *on* the flagged
 * point (after-draw). Band behind, dot in front — the band is context, the dot
 * is the datum. Driven by `anomalies: [indices]` on a dataset; the same flags
 * are spelled out as "(anomaly)" in the sr-only table, so a screen reader gets
 * the signal the colour carries.
 */
const anomalyOverlay = {
  id: 'appChartAnomalies',
  beforeDatasetsDraw(chart, _args, opts) {
    const { ctx, chartArea } = chart;
    for (const { x } of anomalyPoints(chart)) {
      ctx.save();
      ctx.globalAlpha = 0.1;
      ctx.fillStyle = opts.color;
      ctx.fillRect(x - 5, chartArea.top, 10, chartArea.bottom - chartArea.top);
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

/** @returns {(n: number) => string} */
function formatter(el, attr = 'format') {
  const kind = el.getAttribute(attr) || 'number';
  const currency = el.getAttribute('currency') || 'USD';
  if (kind === 'currency') {
    const f = new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 });
    return (n) => f.format(n);
  }
  if (kind === 'percent') return (n) => `${Math.round(n)}%`;
  if (kind === 'compact') {
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
            'center-label', 'legend', 'empty-text', 'loading', 'label'];
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

  render() {
    this.#destroyChart();

    if (this.hasAttribute('loading')) {
      this.setAttribute('aria-busy', 'true');
      this.innerHTML = '<div class="chart-skeleton"></div>';
      return;
    }
    this.removeAttribute('aria-busy');

    if (this.#isEmpty()) {
      this.innerHTML = `<p class="chart-empty">${escHtml(this.getAttribute('empty-text') || 'No data')}</p>`;
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
    const sets = this.#datasets();
    const labels = this.#data.labels || [];
    const showLegend = this.#showLegend(type, sets.length);
    const hasY2 = type === 'line' && sets.some((s) => s.axis === 'y2');
    const segmented = type === 'bar' && this.hasAttribute('segmented');
    const hasAnomalies = sets.some((s) => Array.isArray(s.anomalies) && s.anomalies.length);

    const centerValue = this.getAttribute('center-value');
    const centerLabel = this.getAttribute('center-label');
    const height = this.getAttribute('height') || '200px';

    this.innerHTML = `
      <div class="chart-plot" style="height:${escAttr(height)}">
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
    const plugins = [];
    if (type === 'donut') plugins.push(centreInHole);
    if (type === 'line') plugins.push(hoverCrosshair);
    if (type === 'line' && hasAnomalies) plugins.push(anomalyOverlay);
    if (type === 'bar' && this.hasAttribute('average-line')) plugins.push(averageLine);

    this.#chart = new Chart(this.querySelector('canvas'), {
      type: type === 'donut' ? 'doughnut' : type,
      data: { labels, datasets: sets.map((s, i) => this.#dataset(type, s, i, pal, segmented)) },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        // Chart.js animates on every re-render, and this element re-renders on
        // theme change — an animated repaint on a theme flip reads as a glitch.
        animation: { duration: 240 },
        interaction: { mode: type === 'donut' ? 'nearest' : 'index', intersect: false },
        plugins: {
          legend: showLegend
            ? { position: type === 'donut' ? 'right' : 'bottom', align: 'start',
                labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 8, boxHeight: 8, padding: 12 } }
            : { display: false },
          tooltip: {
            backgroundColor: pal.tick, padding: 8, cornerRadius: 6, displayColors: true,
            usePointStyle: true, boxWidth: 8, boxHeight: 8,
            callbacks: {
              // Each dataset formats on its own axis — a tokens series in a
              // dual-axis chart must not read as dollars in the tooltip.
              label: (c) => `${c.dataset.label ? `${c.dataset.label}: ` : ''}${
                (c.dataset.yAxisID === 'y2' ? fmt2 : fmt)(c.parsed.y ?? c.parsed)}`,
            },
          },
          appChartCrosshair: { color: pal.grid },
          appChartAnomalies: { color: pal.error, surface: pal.surface },
          appChartAverage: { color: pal.tick, font: `${pal.fontSize}px ${pal.font}` },
        },
        scales: type === 'donut' ? {} : this.#scales(pal, fmt, fmt2, { hasY2, segmented }),
      },
      plugins,
    });
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
      // Segmented: the concentration presentation — thin columns, each stack
      // segment a fully-rounded pill. The oversized borderRadius is clamped by
      // Chart.js to half the segment, which is what makes the capsule; the
      // 3px surface border is the visible gap between segments.
      if (segmented) {
        return {
          ...base,
          backgroundColor: slot(pal, i),
          borderColor: pal.surface,
          borderWidth: 3,
          borderRadius: 999,
          borderSkipped: false,
          barPercentage: 0.55,
          categoryPercentage: 0.9,
          maxBarThickness: 14,
        };
      }
      return {
        ...base,
        backgroundColor: slot(pal, i),
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
      borderColor: slot(pal, i),
      backgroundColor: slot(pal, i),
      borderWidth: 2,
      // Straight segments: a spline invents values between the points it was
      // given, which on a spend or latency series is a lie the reader cannot see.
      tension: 0,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: pal.surface,
    };
  }

  #scales(pal, fmt, fmt2, { hasY2 = false, segmented = false } = {}) {
    // `segmented` implies stacking: the pills ARE the stack segments.
    const stacked = this.hasAttribute('stacked') || segmented;
    const scales = {
      x: {
        stacked,
        // Vertical rules add no information on a categorical or time axis and
        // compete with the marks for attention.
        grid: { display: false },
        border: { display: false },
        // Segmented plots carry a dense categorical axis (24 hours): thin the
        // ticks rather than rotate them — slanted labels read slower than a
        // sparser run of upright ones.
        ticks: { color: pal.tick, ...(segmented ? { maxRotation: 0, autoSkip: true, autoSkipPadding: 12 } : {}) },
      },
      y: {
        stacked,
        beginAtZero: true,
        grid: { color: pal.grid, drawTicks: false },
        border: { display: false, dash: [4, 4] },
        ticks: { color: pal.tick, padding: 8, callback: (v) => fmt(v) },
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
        ticks: { color: pal.tick, padding: 8, callback: (v) => fmt2(v) },
      };
    }
    return scales;
  }

  /**
   * The screen-reader view of a canvas. `.sr-only` in styles/, so it costs no
   * layout; it is the "a table view exists" half of not encoding by colour alone.
   */
  #dataTable(labels, sets, fmt, fmt2 = fmt) {
    const head = sets.map((s) => `<th scope="col">${escHtml(s.label || 'Series')}</th>`).join('');
    const body = labels.map((l, r) => `
      <tr><th scope="row">${escHtml(String(l))}</th>${
        sets.map((s) => `<td>${escHtml((s.axis === 'y2' ? fmt2 : fmt)(Number(s.data?.[r] ?? 0)))}${
          Array.isArray(s.anomalies) && s.anomalies.includes(r) ? ' (anomaly)' : ''}</td>`).join('')
      }</tr>`).join('');
    return `<table class="sr-only">
        <caption>${escHtml(this.getAttribute('label') || 'Chart data')}</caption>
        <thead><tr><th scope="col">Label</th>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>`;
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
