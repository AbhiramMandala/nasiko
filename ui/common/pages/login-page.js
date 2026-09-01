import { icons } from '../utils/icons.js';
import '../utils/theme.js'; // side effect: applies the pinned theme (no app-header here)
import '../design-system/app-input/app-input.js';
import '../design-system/app-button/app-button.js';
import { withLoading } from '../utils/async-button.js';
import { setFieldError, clearFieldErrors } from '../utils/field-error.js';
import { loadCss } from '/common/utils/css.js';
const styles = await loadCss(new URL('./login-page.css', import.meta.url));
document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];

const GITHUB_ICON = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>`;
// Nasiko brand mark (barcode "N") — inlined copy of /common/mark-nasiko.svg
// with the bars recolored to currentColor so it adapts to the login card.
const LOGO_ICON = `<svg viewBox="0 0 64 64" fill="none"><g fill="currentColor"><rect width="3.29" height="53.74" rx="1.64"/><rect x="5.52" width="3.29" height="58.45" rx="1.64"/><rect x="11.04" width="3.29" height="63.82" rx="1.64"/><rect x="16.56" width="3.29" height="63.82" rx="1.64"/><rect x="22.08" width="3.29" height="22.84" rx="1.64"/><rect x="27.6" width="3.29" height="22.84" rx="1.64"/><rect x="33.12" width="3.29" height="27.54" rx="1.64"/><rect x="38.63" width="3.29" height="32.25" rx="1.64"/><rect x="44.15" width="3.29" height="22.84" rx="1.64"/><rect x="49.56" y="6.03" width="3.35" height="16.74" rx="1.67"/><rect x="55.19" y="10.26" width="3.29" height="53.74" rx="1.64"/><rect x="60.71" y="14.82" width="3.29" height="49.04" rx="1.64"/><rect x="22.31" y="53.56" width="3.35" height="10.26" rx="1.67"/><rect x="27.89" y="53.56" width="3.29" height="10.08" rx="1.64"/><rect x="33.47" y="43.31" width="3.35" height="20.51" rx="1.67"/><rect x="39.05" y="47.87" width="3.35" height="15.96" rx="1.67"/><rect x="44.39" y="53.56" width="3.35" height="10.26" rx="1.67"/><rect x="49.97" y="53.56" width="3.35" height="10.26" rx="1.67"/></g></svg>`;

/// Providers given a button whenever OIDC is configured at all, even when
/// they aren't the one configured — so a deployment moving between IdPs can
/// see both, and flipping `OIDC_ISSUER_URL` visibly moves which one is live.
///
/// They are NOT all clickable. There is exactly one `/api/auth/oidc/login`
/// route and `IdentityConfig` enables exactly one provider (`ee/identity/
/// src/config.rs`: "up to five providers may be declared; exactly one is
/// enabled"), so a second live-looking button would post to the same route
/// and land the user on the *other* IdP. The ones that aren't configured are
/// therefore rendered `disabled` — present and legible, but honest.
const ALWAYS_OFFERED = ['microsoft', 'okta'];

/// How to present each IdP family that `/api/auth/oidc/status` can report.
/// Keys are the slugs `ee/server/src/oidc.rs::provider_slug` emits; anything
/// unrecognised (including a slug added server-side before this table catches
/// up) falls back to `generic`, so a new provider degrades to a working
/// "Continue with SSO" button rather than an unlabelled one.
const OIDC_PROVIDERS = {
  microsoft: { label: 'Microsoft', icon: icons.microsoft },
  google:    { label: 'Google',    icon: icons.google },
  okta:      { label: 'Okta',      icon: icons.okta },
  keycloak:  { label: 'Keycloak',  icon: icons.sso },
  aws:       { label: 'AWS',       icon: icons.sso },
  generic:   { label: 'SSO',       icon: icons.sso },
};

/// True when the browser already holds a valid session cookie. The cookie is
/// HttpOnly, so the only way to know is to ask the server (`/api/me` is the
/// cheapest authed endpoint — it just echoes the claims).
async function hasSession() {
  try {
    const res = await fetch('/api/me', { credentials: 'same-origin' });
    // Content-type, not just `res.ok`: a host that serves its SPA shell for
    // unknown paths answers 200-with-HTML, which would read as "signed in"
    // and bounce a first-time visitor off the login page in a loop.
    return res.ok && (res.headers.get('content-type') || '').includes('application/json');
  } catch {
    return false;
  }
}

/// A logged-in user must never sit on the login page. `connectedCallback`
/// covers a fresh load; this covers the two ways a page can appear WITHOUT
/// re-running it — a back/forward-cache restore, and a tab becoming visible
/// again after signing in elsewhere. `replace` (not `assign`) so the login
/// entry doesn't pile up in history behind the app.
window.addEventListener('pageshow', async (e) => {
  if (!e.persisted) return; // fresh load — connectedCallback already checked
  if (await hasSession()) window.location.replace('/');
});

class LoginPage extends HTMLElement {
  async connectedCallback() {
    const brandTitle = this.getAttribute('brand-title') || 'Nasiko';
    const subtitle = this.getAttribute('subtitle') || 'Sign in to your workspace';
    // Social sign-in is opt-in per deployment — a bare <login-page> renders
    // no button whose backend route may not exist. GitHub SSO (`github`
    // attribute) exists on EE control planes; Google only where the host
    // page supplies its route via google-href (e.g. the tenant portal BFF).
    const githubRequested = this.hasAttribute('github') && !this.hasAttribute('no-github');
    let showGoogle = this.hasAttribute('google-href') && !this.hasAttribute('no-google');
    const showCredentials = !this.hasAttribute('no-credentials');

    // The `github` attribute says this deployment *wants* GitHub sign-in; it
    // can't know whether the operator actually configured an OAuth app. With
    // no `GITHUB_CLIENT_ID` the login route answers `503`, so a button drawn
    // on the attribute alone is a dead control that still reads as an enabled
    // login method to anyone auditing the page. Confirm with the backend the
    // same way Microsoft does. Fails closed (hidden) on a network error.
    const githubConfigured = async () => {
      if (!githubRequested) return false;
      try {
        const res = await fetch('/api/auth/github/status', { credentials: 'same-origin' });
        const data = await res.json();
        return Boolean(data?.configured);
      } catch {
        return false;
      }
    };

    // Microsoft/OIDC is opt-in per deployment — only show the button once the backend confirms
    // OIDC_ISSUER_URL/CLIENT_ID/CLIENT_SECRET/REDIRECT_URI (or the
    // DB-configured equivalent, see `resolve_oidc_client`) are actually set,
    // so a deployment that hasn't configured SSO never shows a button that
    // would just 503. Fails closed (hidden) on a network error.
    //
    // The same probe reports WHICH IdP family is configured, because there is
    // exactly one `/api/auth/oidc/login` route and the provider is chosen
    // server-side from the issuer URL. A fixed "Continue with Microsoft"
    // label was therefore a coin flip: on an Okta or Keycloak deployment it
    // named an IdP the user would never see, and offering one button per
    // vendor would be worse still — every button would post to the same route
    // and all but one would be a dead end.
    const oidcStatus = async () => {
      if (this.hasAttribute('no-microsoft') || this.hasAttribute('no-sso')) return null;
      try {
        const res = await fetch('/api/auth/oidc/status', { credentials: 'same-origin' });
        const data = await res.json();
        return data?.configured ? (data.provider || 'generic') : null;
      } catch {
        return null;
      }
    };

    // All three probes in flight together — the session check and the GitHub
    // one cost no extra wall clock on top of the OIDC one we already wait for.
    const [sessionActive, showMicrosoft, oidcProvider, showGithub] = await Promise.all([
      hasSession(),
      oidcConfigured(),
      oidcStatus(),
      githubConfigured(),
    ]);
    if (sessionActive) {
      window.location.replace('/');
      return;
    }

    // google-status-href optionally gates the (already opt-in) Google button
    // the same way the OIDC button's is gated above.
    const googleHref = this.getAttribute('google-href');
    const googleStatusHref = this.getAttribute('google-status-href');
    if (showGoogle && googleStatusHref) {
      try {
        const res = await fetch(googleStatusHref, { credentials: 'same-origin' });
        const data = await res.json();
        showGoogle = Boolean(data?.configured);
      } catch {
        showGoogle = false;
      }
    }

    document.title = `${brandTitle} — Sign In`;
    let oauthSection = '';
    if (showGithub || showGoogle || oidcProvider) {
      let buttons = '';
      if (oidcProvider) {
        // Configured provider first so the clickable one is never buried, then
        // the rest of the offered set. `oidcProvider` may already be in
        // ALWAYS_OFFERED, hence the filter rather than a concat.
        const offered = [oidcProvider, ...ALWAYS_OFFERED.filter((p) => p !== oidcProvider)];
        for (const slug of offered) {
          const { label, icon } = OIDC_PROVIDERS[slug] || OIDC_PROVIDERS.generic;
          buttons += slug === oidcProvider
            ? `<a href="/api/auth/oidc/login" class="btn-oauth">${icon} Continue with ${label}</a>`
            : `<button type="button" class="btn-oauth" disabled ` +
              `title="${label} is not the identity provider configured on this deployment">` +
              `${icon} Continue with ${label}</button>`;
        }
      }
      // GitHub is a button, not a link: unlike the OIDC route (a plain 302 to
      // the IdP), the GitHub login route answers with `{auth_url}` JSON that
      // has to be read and followed. Navigating straight to it lands on the
      // static-page fallback, which bounces unauthenticated visitors right
      // back to /login.html — the "GitHub login does nothing" symptom.
      if (showGithub) buttons += `<button type="button" class="btn-oauth" id="github-oauth">${GITHUB_ICON} Continue with GitHub</button>`;
      if (showGoogle) buttons += `<a href="${googleHref}" class="btn-oauth">${icons.google} Continue with Google</a>`;
      // The divider separates the credentials form from the OAuth buttons —
      // with no form above it, a lone "or" reads as a rendering glitch.
      oauthSection = `
        ${showCredentials ? '<div class="divider">or</div>' : ''}
        <div class="oauth-section">${buttons}</div>
        <div class="error-msg" id="oauth-error"></div>
      `;
    }

    this.innerHTML = `
      <div class="login-card">
        <div class="brand">
          <div class="brand-icon">${LOGO_ICON}</div>
        </div>
        <h1 class="login-title">Sign in to ${brandTitle}</h1>
        <p class="subtitle">${subtitle}</p>
        ${showCredentials ? `
          <form id="login-form">
            <app-input id="username" label="Username" type="text" placeholder="admin"
              autocomplete="username" required></app-input>
            <app-input id="password" label="Password" type="password" placeholder="password"
              autocomplete="current-password" required></app-input>
            <app-button type="submit" id="submit-btn" block>Sign In</app-button>
          </form>
        ` : ''}
        ${oauthSection}
      </div>
    `;

    if (showCredentials) this.#setupForm();
    if (showGithub) this.#setupGithub();
  }

  /// `GET /api/auth/github/login-user` → `{auth_url}` → follow it. Public
  /// route (no session needed), which is what makes it the right one for a
  /// sign-in button; `/api/github/login` is the authed connect-an-account
  /// variant and 401s here.
  #setupGithub() {
    const btn = this.querySelector('#github-oauth');
    const errorMsg = this.querySelector('#oauth-error');

    btn.addEventListener('click', async () => {
      errorMsg.classList.remove('visible');
      btn.disabled = true;
      try {
        const res = await fetch('/api/auth/github/login-user', { credentials: 'same-origin' });
        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || 'GitHub sign-in is not available');
        }
        const { auth_url: authUrl } = await res.json();
        if (!authUrl) throw new Error('GitHub sign-in is not available');
        window.location.assign(authUrl);
      } catch (err) {
        errorMsg.textContent = err.message;
        errorMsg.classList.add('visible');
        btn.disabled = false;
      }
    });
  }

  /// A rejected credential implicates both fields, so both redden while the
  /// message is carried once, under the password.
  #setFormError(message) {
    const username = this.querySelector('#username');
    const password = this.querySelector('#password');
    if (!message) return clearFieldErrors(username, password);
    username.setAttribute('state', 'error');
    setFieldError(password, message);
  }

  #setupForm() {
    const form = this.querySelector('#login-form');
    const submitBtn = this.querySelector('#submit-btn');

    // withLoading owns the disable/spinner/relabel cycle — an <app-button>
    // renders an inner <button>, so assigning textContent would wipe it.
    const signIn = withLoading(submitBtn, 'Signing in…', async () => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            username: this.querySelector('#username').value,
            password: this.querySelector('#password').value,
          }),
        });

        if (!res.ok) {
          const data = await res.json().catch(() => null);
          throw new Error(data?.error || 'Invalid credentials');
        }

        // `replace`, not `href`: an `href` assignment leaves /login.html in
        // the back stack, so Back from the app shows the login page again to
        // an already-authenticated user.
        window.location.replace('/');
      } catch (err) {
        this.#setFormError(err.message);
      }
    });

    // Both fields carry the rejected-credential state, and `username` gets it
    // set by hand above — so editing either one clears the pair.
    form.addEventListener('input', () => this.#setFormError(null));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.#setFormError(null);
      signIn();
    });
  }
}

customElements.define('login-page', LoginPage);
