/**
 * `<app-flow-graph>` — Interactive node graph with animated connections.
 *
 * Ported from Flutter's `app_flow_showcase.dart`. Renders a left-to-right
 * flow diagram on a dot-grid canvas with:
 *
 *   - Curved cubic-bezier edges between adjacent stages
 *   - Travelling "request particle" animation along each edge
 *   - Hover emphasis on individual nodes (highlights connected edges)
 *   - Pulsing glow on emphasized (engine) nodes
 *   - Dot-grid background
 *   - Optional direction arrows on edges
 *   - Responsive node layout with wave offset for chains
 *
 * All continuous animation halts under `prefers-reduced-motion: reduce`.
 *
 * Usage:
 *   <app-flow-graph
 *     title="How it works"
 *     canvas-height="260">
 *   </app-flow-graph>
 *
 *   // Then in JS:
 *   const graph = document.querySelector('app-flow-graph');
 *   graph.stages = [
 *     { label: 'Input', nodes: [{ icon: '📥', title: 'User Query' }] },
 *     { label: 'Process', nodes: [
 *       { icon: '🤖', title: 'Router', emphasized: true },
 *     ]},
 *     { label: 'Output', nodes: [
 *       { icon: '📊', title: 'Analytics' },
 *       { icon: '💬', title: 'Response' },
 *     ]},
 *   ];
 *
 * @element app-flow-graph
 * @attr {string} title         - Panel header text
 * @attr {string} subtitle      - Optional description below title
 * @attr {number} canvas-height - Canvas height in px (default 260)
 * @attr {boolean} show-arrows  - Show direction arrowheads on edges
 * @attr {boolean} straight     - Force single-node stages onto a flat line
 */

import { prefersReducedMotion } from '../core/motion.js';

// ── Constants ──────────────────────────────────────────────────────────

const DOT_GRID_STEP = 24;
const PARTICLE_CYCLE_MS = 2600;
const NODE_MAX_W = 216;
const NODE_MIN_W = 60;

// ── Styles ─────────────────────────────────────────────────────────────

const _sheet = new CSSStyleSheet();
_sheet.replaceSync(`
@scope (app-flow-graph) {
  :scope {
    display: block;
    width: 100%;
    position: relative;
  }

  .flow-panel {
    width: 100%;
    padding: var(--s-24, 24px);
    border: 1px solid var(--content-border, rgba(0,0,0,0.08));
    border-radius: var(--r-12, 12px);
    background: var(--content-bg, #FFFFFF);
  }
  :root[data-theme="dark"] & .flow-panel,
  :root:not([data-theme]) .flow-panel {
    background: var(--content-bg, #2C2A28);
    border-color: var(--content-border, rgba(255,255,255,0.08));
  }

  .flow-header {
    display: flex;
    align-items: center;
    gap: var(--s-8, 8px);
    margin-bottom: var(--s-16, 16px);
  }

  .flow-live-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fg-brand, #EAB308);
    flex-shrink: 0;
  }
  .flow-live-dot.is-animated {
    animation: flow-dot-breathe 2.6s ease-in-out infinite;
  }
  @keyframes flow-dot-breathe {
    0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.35); }
    50% { opacity: 0.65; box-shadow: 0 0 6px 1px rgba(234, 179, 8, 0.35); }
  }

  .flow-title {
    font-weight: 600;
    font-size: 14px;
    color: var(--content-fg, #1E1D1B);
  }
  :root[data-theme="dark"] & .flow-title,
  :root:not([data-theme]) .flow-title {
    color: var(--sand-100, #F5F3EF);
  }

  .flow-subtitle {
    font-size: 13px;
    color: var(--fg-secondary, #78716C);
    margin-bottom: var(--s-4, 4px);
  }

  .flow-canvas-wrap {
    position: relative;
    width: 100%;
    overflow: hidden;
  }

  .flow-canvas {
    display: block;
    width: 100%;
    height: 100%;
  }

  /* ── Node cards ── */
  .flow-node {
    position: absolute;
    display: flex;
    align-items: center;
    gap: var(--s-8, 8px);
    padding: 8px 12px;
    border-radius: var(--r-12, 12px);
    border: 1px solid;
    cursor: default;
    transition: border-color 150ms, box-shadow 150ms;
    overflow: hidden;
  }
  .flow-node .node-icon {
    font-size: 16px;
    flex-shrink: 0;
    line-height: 1;
  }
  .flow-node .node-title {
    font-size: 12px;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--content-fg, #1E1D1B);
  }
  :root[data-theme="dark"] & .flow-node .node-title,
  :root:not([data-theme]) .flow-node .node-title {
    color: var(--sand-100, #F5F3EF);
  }
  .flow-node .node-subtitle {
    font-size: 11px;
    color: var(--fg-secondary, #78716C);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .flow-node .node-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    gap: 1px;
  }

  /* Normal node */
  .flow-node.node-normal {
    background: var(--content-bg, #FFFFFF);
    border-color: rgba(234, 179, 8, 0.45);
    box-shadow: 0 0 12px rgba(234, 179, 8, 0.08);
  }
  :root[data-theme="dark"] & .flow-node.node-normal,
  :root:not([data-theme]) .flow-node.node-normal {
    background: var(--content-bg, #2C2A28);
  }
  .flow-node.node-normal:hover {
    border-color: rgba(234, 179, 8, 0.8);
  }

  /* Emphasized (engine) node */
  .flow-node.node-emphasized {
    background: var(--yellow-50, #FFFBEB);
    border-color: rgba(234, 179, 8, 0.8);
    border-width: 1.5px;
    box-shadow: 0 0 16px rgba(234, 179, 8, 0.18);
  }
  :root[data-theme="dark"] & .flow-node.node-emphasized,
  :root:not([data-theme]) .flow-node.node-emphasized {
    background: rgba(234, 179, 8, 0.12);
  }
  .flow-node.node-emphasized.is-pulsing {
    animation: flow-node-pulse 2.6s ease-in-out infinite;
  }
  @keyframes flow-node-pulse {
    0%, 100% { box-shadow: 0 0 8px rgba(234, 179, 8, 0.18); }
    50%      { box-shadow: 0 0 30px 15px rgba(234, 179, 8, 0.12); }
  }

  /* ── Stage labels ── */
  .flow-label {
    position: absolute;
    text-align: center;
    font-size: 11px;
    color: var(--fg-secondary, #78716C);
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .flow-live-dot.is-animated { animation: none; }
    .flow-node.node-emphasized.is-pulsing { animation: none; }
  }
}
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];

// ── Geometry (ported from _SceneGeometry) ──────────────────────────────

function computeGeometry(canvasW, canvasH, stages, { hasLabels, straight }) {
  const counts = stages.map(s => s.nodes.length);
  const stageCount = counts.length;
  const labelH = hasLabels ? 26 : 0;
  const areaTop = labelH;
  const areaH = canvasH - areaTop;
  const band = canvasW / stageCount;
  const nodeW = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, band - 28));
  const dense = areaH < 220;

  // Chain wave (single-node stages get a gentle sine wave)
  const isChain = stageCount >= 3 && counts.every(c => c === 1);
  const amplitude = isChain && !straight ? areaH * 0.20 : 0;
  const waveOffset = (s) => isChain
    ? Math.sin(s / (stageCount - 1) * Math.PI * 1.5) * amplitude
    : 0;

  const rects = [];
  for (let s = 0; s < stageCount; s++) {
    const col = [];
    for (let i = 0; i < counts[s]; i++) {
      const cx = band * s + band / 2;
      const cy = areaTop + areaH * ((i + 0.5) / counts[s]) + waveOffset(s);
      const nh = Math.min(dense ? 52 : 64, Math.max(40, areaH / counts[s] - 10));
      col.push({
        x: cx - nodeW / 2,
        y: cy - nh / 2,
        w: nodeW,
        h: nh,
        cx, cy,
      });
    }
    rects.push(col);
  }

  return { rects, band, dense, areaTop, labelH, stageCount, counts };
}

// ── Canvas painting ────────────────────────────────────────────────────

function paintScene(ctx, w, h, geo, stages, phase, hovered, showArrows, animate) {
  ctx.clearRect(0, 0, w, h);

  // Dot grid
  const isDark = document.documentElement.dataset.theme === 'dark'
    || !document.documentElement.dataset.theme;
  const dotColor = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
  ctx.fillStyle = dotColor;
  for (let x = DOT_GRID_STEP / 2; x < w; x += DOT_GRID_STEP) {
    for (let y = DOT_GRID_STEP / 2; y < h; y += DOT_GRID_STEP) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Brand color
  const brand = { r: 234, g: 179, b: 8 };

  // Edges: full bipartite between adjacent stages
  let edgeIdx = 0;
  for (let s = 0; s < geo.stageCount - 1; s++) {
    for (let a = 0; a < geo.counts[s]; a++) {
      for (let b = 0; b < geo.counts[s + 1]; b++) {
        const emphasized = (hovered && (hovered[0] === s && hovered[1] === a))
          || (hovered && (hovered[0] === s + 1 && hovered[1] === b));

        const from = geo.rects[s][a];
        const to = geo.rects[s + 1][b];
        const ax = from.x + from.w;
        const ay = from.cy;
        const bx = to.x;
        const by = to.cy;
        const dx = (bx - ax) * 0.5;

        // Draw edge
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.bezierCurveTo(ax + dx, ay, bx - dx, by, bx, by);
        ctx.strokeStyle = `rgba(${brand.r},${brand.g},${brand.b},${emphasized ? 0.55 : 0.30})`;
        ctx.lineWidth = emphasized ? 2.4 : 1.6;
        ctx.lineCap = 'round';
        ctx.stroke();

        // Direction arrow
        if (showArrows) {
          const t2 = 0.95;
          const arrowPt = _bezierPoint(ax, ay, ax + dx, ay, bx - dx, by, bx, by, t2);
          const arrowTan = _bezierTangent(ax, ay, ax + dx, ay, bx - dx, by, bx, by, t2);
          const angle = Math.atan2(arrowTan.y, arrowTan.x);
          ctx.beginPath();
          ctx.moveTo(arrowPt.x, arrowPt.y);
          ctx.lineTo(arrowPt.x - 7 * Math.cos(angle - Math.PI / 6),
                     arrowPt.y - 7 * Math.sin(angle - Math.PI / 6));
          ctx.lineTo(arrowPt.x - 7 * Math.cos(angle + Math.PI / 6),
                     arrowPt.y - 7 * Math.sin(angle + Math.PI / 6));
          ctx.closePath();
          ctx.fillStyle = `rgba(${brand.r},${brand.g},${brand.b},${emphasized ? 0.65 : 0.42})`;
          ctx.fill();
        }

        // Particle animation
        if (animate) {
          const stagger = (edgeIdx * 0.23) % 1.0;
          const pt = (phase + stagger) % 1.0;
          const presence = Math.sin(pt * Math.PI);
          const particlePt = _bezierPoint(ax, ay, ax + dx, ay, bx - dx, by, bx, by, pt);

          // Comet tail (approximate with a line from pt-0.08 to pt)
          const tailT = Math.max(0, pt - 0.08);
          const tailPt = _bezierPoint(ax, ay, ax + dx, ay, bx - dx, by, bx, by, tailT);

          ctx.beginPath();
          ctx.moveTo(tailPt.x, tailPt.y);
          ctx.lineTo(particlePt.x, particlePt.y);
          ctx.strokeStyle = `rgba(${brand.r},${brand.g},${brand.b},${0.45 * presence})`;
          ctx.lineWidth = 2.2;
          ctx.stroke();

          // Glow halo
          ctx.beginPath();
          ctx.arc(particlePt.x, particlePt.y, 7, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${brand.r},${brand.g},${brand.b},${0.16 * presence})`;
          ctx.fill();

          // Particle dot
          ctx.beginPath();
          ctx.arc(particlePt.x, particlePt.y, 2.6, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(${brand.r},${brand.g},${brand.b},${presence})`;
          ctx.fill();
        }

        edgeIdx++;
      }
    }
  }
}

// Cubic bezier helpers
function _bezierPoint(x0, y0, cx1, cy1, cx2, cy2, x3, y3, t) {
  const u = 1 - t;
  return {
    x: u*u*u*x0 + 3*u*u*t*cx1 + 3*u*t*t*cx2 + t*t*t*x3,
    y: u*u*u*y0 + 3*u*u*t*cy1 + 3*u*t*t*cy2 + t*t*t*y3,
  };
}
function _bezierTangent(x0, y0, cx1, cy1, cx2, cy2, x3, y3, t) {
  const u = 1 - t;
  return {
    x: 3*u*u*(cx1-x0) + 6*u*t*(cx2-cx1) + 3*t*t*(x3-cx2),
    y: 3*u*u*(cy1-y0) + 6*u*t*(cy2-cy1) + 3*t*t*(y3-cy2),
  };
}

// ── Component ──────────────────────────────────────────────────────────

class AppFlowGraph extends HTMLElement {
  #stages = [];
  #geo = null;
  #canvas = null;
  #ctx = null;
  #phase = 0;
  #animFrame = null;
  #hovered = null;
  #lastTime = 0;
  #resizeObserver = null;

  static get observedAttributes() {
    return ['title', 'subtitle', 'canvas-height', 'show-arrows', 'straight'];
  }

  set stages(list) {
    this.#stages = list || [];
    if (this.isConnected) this.#rebuild();
  }

  get stages() { return this.#stages; }

  connectedCallback() {
    this.#rebuild();
  }

  disconnectedCallback() {
    if (this.#animFrame) cancelAnimationFrame(this.#animFrame);
    this.#animFrame = null;
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
  }

  attributeChangedCallback() {
    if (this.isConnected) this.#rebuild();
  }

  #rebuild() {
    const title = this.getAttribute('title') || '';
    const subtitle = this.getAttribute('subtitle') || '';
    const height = parseInt(this.getAttribute('canvas-height')) || 260;
    const reduced = prefersReducedMotion();

    this.innerHTML = `
      <div class="flow-panel">
        <div class="flow-header">
          <div class="flow-live-dot ${reduced ? '' : 'is-animated'}"></div>
          <span class="flow-title">${_esc(title)}</span>
        </div>
        ${subtitle ? `<div class="flow-subtitle">${_esc(subtitle)}</div>` : ''}
        <div class="flow-canvas-wrap" style="height: ${height}px">
          <canvas class="flow-canvas"></canvas>
        </div>
      </div>
    `;

    this.#canvas = this.querySelector('.flow-canvas');
    this.#ctx = this.#canvas.getContext('2d');

    // Size canvas to container
    const wrap = this.querySelector('.flow-canvas-wrap');
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = new ResizeObserver(() => this.#layout());
    this.#resizeObserver.observe(wrap);

    this.#layout();
  }

  #layout() {
    const wrap = this.querySelector('.flow-canvas-wrap');
    if (!wrap || !this.#canvas) return;

    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    this.#canvas.width = w * dpr;
    this.#canvas.height = h * dpr;
    this.#canvas.style.width = `${w}px`;
    this.#canvas.style.height = `${h}px`;
    this.#ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (!this.#stages.length) return;

    const hasLabels = this.#stages.some(s => s.label);
    const straight = this.hasAttribute('straight');
    this.#geo = computeGeometry(w, h, this.#stages, { hasLabels, straight });

    // Place node DOM elements
    this.#placeNodes(wrap);

    // Start animation loop
    this.#startLoop();
  }

  #placeNodes(wrap) {
    // Remove old node elements
    wrap.querySelectorAll('.flow-node, .flow-label').forEach(el => el.remove());

    if (!this.#geo) return;

    // Stage labels
    for (let s = 0; s < this.#stages.length; s++) {
      const stage = this.#stages[s];
      if (!stage.label) continue;

      // Find topmost node in this column
      let topY = Infinity;
      for (const r of this.#geo.rects[s]) topY = Math.min(topY, r.y);

      const label = document.createElement('div');
      label.className = 'flow-label';
      label.textContent = stage.label;
      label.style.left = `${this.#geo.band * s}px`;
      label.style.width = `${this.#geo.band}px`;
      label.style.top = `${Math.max(0, topY - 22)}px`;
      wrap.appendChild(label);
    }

    // Node cards
    for (let s = 0; s < this.#stages.length; s++) {
      for (let i = 0; i < this.#stages[s].nodes.length; i++) {
        const node = this.#stages[s].nodes[i];
        const rect = this.#geo.rects[s][i];
        const reduced = prefersReducedMotion();

        const el = document.createElement('div');
        el.className = `flow-node ${node.emphasized ? 'node-emphasized' : 'node-normal'} ${node.emphasized && !reduced ? 'is-pulsing' : ''}`;
        el.style.left = `${rect.x}px`;
        el.style.top = `${rect.y}px`;
        el.style.width = `${rect.w}px`;
        el.style.height = `${rect.h}px`;

        el.innerHTML = `
          <span class="node-icon">${_esc(node.icon || '●')}</span>
          <div class="node-text">
            <span class="node-title">${_esc(node.title)}</span>
            ${node.subtitle ? `<span class="node-subtitle">${_esc(node.subtitle)}</span>` : ''}
          </div>
        `;

        // Hover tracking
        el.addEventListener('pointerenter', () => {
          this.#hovered = [s, i];
        });
        el.addEventListener('pointerleave', () => {
          this.#hovered = null;
        });

        // Tooltip
        if (node.tooltip) {
          el.setAttribute('data-tooltip', node.tooltip);
        }

        wrap.appendChild(el);
      }
    }
  }

  #startLoop() {
    if (this.#animFrame) cancelAnimationFrame(this.#animFrame);

    if (prefersReducedMotion()) {
      // Just paint static once
      this.#paint(0);
      return;
    }

    this.#lastTime = performance.now();
    const loop = (now) => {
      if (!this.isConnected) return;
      const dt = now - this.#lastTime;
      this.#lastTime = now;
      this.#phase = (this.#phase + dt / PARTICLE_CYCLE_MS) % 1.0;
      this.#paint(this.#phase);
      this.#animFrame = requestAnimationFrame(loop);
    };
    this.#animFrame = requestAnimationFrame(loop);
  }

  #paint(phase) {
    if (!this.#ctx || !this.#geo) return;
    const w = this.#canvas.width / (window.devicePixelRatio || 1);
    const h = this.#canvas.height / (window.devicePixelRatio || 1);
    const showArrows = this.hasAttribute('show-arrows');
    const animate = !prefersReducedMotion();
    paintScene(this.#ctx, w, h, this.#geo, this.#stages, phase,
      this.#hovered, showArrows, animate);
  }
}

function _esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

if (!customElements.get('app-flow-graph')) {
  customElements.define('app-flow-graph', AppFlowGraph);
}

export { AppFlowGraph };
