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
 * @element app-chart
 * @attr {string} type - `line` | `bar` | `donut` | `hbar` | `progress` (default `line`)
 * @attr {boolean} stacked - `bar` only: stack datasets instead of grouping them
 * @attr {string} height - Plot height, any CSS length (default `200px`). Canvas forms only.
 * @attr {string} format - Value formatting: `number` (default) | `currency` | `percent` | `compact`
 * @attr {string} currency - ISO code for `format="currency"` (default `USD`)
 * @attr {string} center-value - `donut` only: the figure drawn in the hole
 * @attr {string} center-label - `donut` only: the caption under it
 * @attr {string} legend - `auto` (default: on for donut and for 2+ series) | `on` | `off`
 * @attr {string} empty-text - Shown when `data` is empty (default "No data")
 * @attr {boolean} loading - Shimmer placeholder instead of the plot
 * @attr {string} label - Accessible name for the plot. Falls back to the type.
 * @prop {object|Array} data - Canvas forms take Chart.js shape:
 *   `{ labels: string[], datasets: [{ label, data }] }`. Row forms take
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
import { escHtml, escAttr } from '/common/utils/escape.js';
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

/** @returns {(n: number) => string} */
function formatter(el) {
  const kind = el.getAttribute('format') || 'number';
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
    return ['type', 'stacked', 'height', 'format', 'currency', 'center-value',
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
    const sets = this.#datasets();
    const labels = this.#data.labels || [];
    const showLegend = this.#showLegend(type, sets.length);

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
      ${this.#dataTable(labels, sets, fmt)}`;

    Chart.defaults.font.family = pal.font;
    Chart.defaults.font.size = pal.fontSize;
    Chart.defaults.color = pal.tick;

    this.#chart = new Chart(this.querySelector('canvas'), {
      type: type === 'donut' ? 'doughnut' : type,
      data: { labels, datasets: sets.map((s, i) => this.#dataset(type, s, i, pal)) },
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
              label: (c) => `${c.dataset.label ? `${c.dataset.label}: ` : ''}${fmt(c.parsed.y ?? c.parsed)}`,
            },
          },
        },
        scales: type === 'donut' ? {} : this.#scales(pal, fmt),
      },
      plugins: type === 'donut' ? [centreInHole] : [],
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
  #dataset(type, s, i, pal) {
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

  #scales(pal, fmt) {
    const stacked = this.hasAttribute('stacked');
    return {
      x: {
        stacked,
        // Vertical rules add no information on a categorical or time axis and
        // compete with the marks for attention.
        grid: { display: false },
        border: { display: false },
        ticks: { color: pal.tick },
      },
      y: {
        stacked,
        beginAtZero: true,
        grid: { color: pal.grid, drawTicks: false },
        border: { display: false, dash: [4, 4] },
        ticks: { color: pal.tick, padding: 8, callback: (v) => fmt(v) },
      },
    };
  }

  /**
   * The screen-reader view of a canvas. `.sr-only` in styles/, so it costs no
   * layout; it is the "a table view exists" half of not encoding by colour alone.
   */
  #dataTable(labels, sets, fmt) {
    const head = sets.map((s) => `<th scope="col">${escHtml(s.label || 'Series')}</th>`).join('');
    const body = labels.map((l, r) => `
      <tr><th scope="row">${escHtml(String(l))}</th>${
        sets.map((s) => `<td>${escHtml(fmt(Number(s.data?.[r] ?? 0)))}</td>`).join('')
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
