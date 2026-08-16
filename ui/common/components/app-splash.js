/**
 * `<app-splash>` — Full-viewport splash screen with the Nasiko logo.
 *
 * Ported from Flutter's `splash_screen.dart`. Shows a centered logo on the
 * shell background, holds for a minimum of 1.5 seconds (so the brand mark
 * registers even on fast connections), then cross-fades into the real app.
 *
 * Usage in index.html:
 *   <body>
 *     <app-splash></app-splash>
 *     <app-header hidden></app-header>
 *     <main id="outlet" hidden></main>
 *   </body>
 *
 * Then in app.js:
 *   import { dismissSplash } from '/common/components/app-splash.js';
 *   await boot();
 *   dismissSplash();
 *
 * The splash auto-dismisses after 4 seconds as a safety net (e.g. if a
 * script error prevents `dismissSplash()` from being called).
 *
 * Styling is done via an adopted stylesheet so it renders before the
 * component upgrades (the `:not(:defined)` rule in global.css reserves
 * the full viewport). Font preloading is triggered here to overlap with
 * the minimum hold time.
 */

const SPLASH_MIN_MS = 1500;
const SPLASH_SAFETY_MS = 4000;
const FADE_MS = 300;

let _splashEl = null;
let _readyAt = null;
let _dismissed = false;

/**
 * Signal that the app is ready. The splash will fade out after the
 * minimum hold time has elapsed.
 */
export function dismissSplash() {
  if (_dismissed) return;
  _dismissed = true;

  const elapsed = Date.now() - (_readyAt || Date.now());
  const remaining = Math.max(0, SPLASH_MIN_MS - elapsed);

  setTimeout(() => _fadeOut(), remaining);
}

function _fadeOut() {
  const el = _splashEl || document.querySelector('app-splash');
  if (!el) {
    _revealApp();
    return;
  }

  // Reduced motion — instant removal
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    el.remove();
    _revealApp();
    return;
  }

  el.style.transition = `opacity ${FADE_MS}ms cubic-bezier(0.33, 1, 0.68, 1)`;
  el.style.opacity = '0';
  el.addEventListener('transitionend', () => {
    el.remove();
    _revealApp();
  }, { once: true });

  // Safety: remove after fade duration even if transitionend doesn't fire
  setTimeout(() => {
    if (el.parentNode) el.remove();
    _revealApp();
  }, FADE_MS + 50);
}

function _revealApp() {
  // Un-hide the app shell elements
  const header = document.querySelector('app-header');
  const outlet = document.getElementById('outlet');
  if (header) header.hidden = false;
  if (outlet) outlet.hidden = false;

  // Fade-in the app content
  const content = header?.parentElement;
  if (content && !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
    for (const child of content.children) {
      if (child.tagName === 'APP-SPLASH') continue;
      child.style.animation = `motion-fade-in ${FADE_MS}ms cubic-bezier(0.33, 1, 0.68, 1) both`;
    }
  }
}

// ── Inline styles (injected before component upgrade) ───────────────────

const _sheet = new CSSStyleSheet();
_sheet.replaceSync(`
  app-splash,
  app-splash:not(:defined) {
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    /* Follow the active theme. --shell-bg is the ink rail colour and is dark in
       both themes, so using it here put a dark full-screen panel in front of a
       light app. The page surface token is the one that actually flips. */
    background: var(--color-bg-base);
    /* Ensure it sits above everything during load */
  }

  app-splash .splash-logo {
    /* 128px read as oversized against the shell it hands off to — the mark is
       a brand beat, not the subject of the screen. */
    width: 72px;
    height: 72px;
    filter: var(--splash-logo-glow, drop-shadow(0 2px 10px rgba(234, 179, 8, 0.14)));
    animation: splash-breathe 2s ease-in-out infinite;
  }

  /* Smaller logo on very small viewports */
  @media (max-width: 480px) {
    app-splash .splash-logo {
      width: 56px;
      height: 56px;
    }
  }

  @keyframes splash-breathe {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.85; transform: scale(1.02); }
  }

  @media (prefers-reduced-motion: reduce) {
    app-splash .splash-logo {
      animation: none;
    }
  }
`);
document.adoptedStyleSheets = [...document.adoptedStyleSheets, _sheet];

// ── Component definition ────────────────────────────────────────────────

class AppSplash extends HTMLElement {
  connectedCallback() {
    _splashEl = this;
    _readyAt = Date.now();

    // Render logo
    this.innerHTML = `
      <img class="splash-logo"
           src="/common/mark-nasiko.svg"
           alt="Nasiko"
           width="72"
           height="72" />
    `;

    // Preload fonts (overlap with splash hold time)
    _preloadFonts();

    // Safety net: auto-dismiss after 4s even if nothing calls dismissSplash()
    setTimeout(() => {
      if (!_dismissed) dismissSplash();
    }, SPLASH_SAFETY_MS);
  }

  disconnectedCallback() {
    if (_splashEl === this) _splashEl = null;
  }
}

function _preloadFonts() {
  const fonts = [
    '/common/fonts/Inter-VariableFont_opsz.ttf',
    '/common/fonts/ChivoMono-Regular.ttf',
  ];
  for (const href of fonts) {
    if (document.querySelector(`link[href="${href}"]`)) continue;
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'font';
    link.type = 'font/ttf';
    link.href = href;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }
}

if (!customElements.get('app-splash')) {
  customElements.define('app-splash', AppSplash);
}
