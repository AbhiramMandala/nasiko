/**
 * Self-service password change, opened from the account menu.
 *
 * Distinct from the Users page's "New Password" field, which is an
 * administrator setting *someone else's* password through `PUT /users/{id}`.
 * That route revokes every session for the target and cannot hand back a
 * replacement, so it is the wrong flow for your own account. This one confirms
 * with the current password and keeps the caller signed in.
 *
 * @element change-password-modal
 * @method open() - Clears the fields and shows the dialog
 */
import { apiFetch } from '/common/services/api.js';
import { showToast } from '/common/utils/toast.js';
import { loadCss } from '/common/utils/css.js';
import '/common/design-system/app-modal/app-modal.js';
import '/common/design-system/app-input/app-input.js';
import '/common/design-system/app-button/app-button.js';

const styles = await loadCss(new URL('./change-password-modal.css', import.meta.url));

// Mirrors MIN_PASSWORD_LEN in oss/server/src/auth/login.rs. Client-side only,
// for fast feedback — the server enforces the rule regardless.
const MIN_PASSWORD_LEN = 8;

class ChangePasswordModal extends HTMLElement {
  #modal = null;
  // Enter is bound on every field AND on the button, and the request spends
  // ~500ms in bcrypt. Without this a second Enter fires a duplicate POST whose
  // `current_password` the first one has already invalidated, so the user gets
  // a spurious failure on what was actually a success. `loading` on the button
  // is styling only; it blocks nothing.
  #busy = false;

  connectedCallback() {
    if (this.#modal) return;
    this.innerHTML = `
      <app-modal id="cp-modal" heading="Change password">
        <div class="modal-form">
          <app-input id="cp-current" label="Current password" type="password"
            autocomplete="current-password"></app-input>
          <app-input id="cp-new" label="New password" type="password"
            autocomplete="new-password"></app-input>
          <app-input id="cp-confirm" label="Confirm new password" type="password"
            autocomplete="new-password"></app-input>
          <p class="hint">At least ${MIN_PASSWORD_LEN} characters. Your other sessions will be signed out.</p>
          <div class="form-actions" data-slot="footer">
            <app-button variant="secondary" id="cp-cancel">Cancel</app-button>
            <app-button variant="primary" id="cp-save">Change password</app-button>
          </div>
        </div>
      </app-modal>`;

    this.#modal = this.querySelector('#cp-modal');
    this.querySelector('#cp-cancel').addEventListener('click', () => this.#modal.close());
    this.querySelector('#cp-save').addEventListener('click', () => this.#submit());

    // Enter anywhere in the form submits, matching native form behaviour.
    this.querySelectorAll('app-input').forEach((input) => {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.#submit(); }
      });
    });
  }

  open() {
    this.connectedCallback();
    for (const id of ['#cp-current', '#cp-new', '#cp-confirm']) this.querySelector(id).value = '';
    this.#modal.open();
    this.querySelector('#cp-current').focus?.();
  }

  async #submit() {
    const current_password = this.querySelector('#cp-current').value;
    const new_password = this.querySelector('#cp-new').value;
    const confirm = this.querySelector('#cp-confirm').value;

    if (!current_password || !new_password) {
      showToast('Enter your current and new password'); return;
    }
    // Spread, not `.length`: the server counts characters, and `.length` would
    // measure UTF-16 units — rejecting a 7-character CJK password the server
    // accepts, and accepting 4 emoji it rejects.
    if ([...new_password].length < MIN_PASSWORD_LEN) {
      showToast(`Password must be at least ${MIN_PASSWORD_LEN} characters`); return;
    }
    if (new_password !== confirm) {
      showToast('New passwords do not match'); return;
    }
    if (new_password === current_password) {
      showToast('New password must differ from the current one'); return;
    }

    if (this.#busy) return;
    this.#busy = true;
    const saveBtn = this.querySelector('#cp-save');
    saveBtn.setAttribute('loading', '');
    try {
      const res = await apiFetch('/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password, new_password }),
      });
      if (!res.ok) { showToast(await this.#errorText(res)); return; }

      // 204 means the password changed but the replacement session could not be
      // minted, so the server cleared the cookie — this session is gone too.
      // Saying "your OTHER sessions" here would leave the user to discover that
      // by hitting an unexplained 401 on their next click.
      if (res.status === 204) {
        this.#modal.close();
        showToast('Password changed. Please sign in again with your new password.');
        setTimeout(() => { window.location.href = '/login.html'; }, 1500);
        return;
      }

      this.#modal.close();
      showToast('Password changed. Your other sessions have been signed out.');
    } catch {
      showToast('Could not reach the server. Try again.');
    } finally {
      this.#busy = false;
      saveBtn.removeAttribute('loading');
    }
  }

  /** The server sends `{"error", "code"}` per API_CONVENTIONS §2; fall back to
   *  the raw body so an unexpected shape still surfaces something useful. */
  async #errorText(res) {
    const body = await res.text();
    try {
      const parsed = JSON.parse(body);
      if (parsed?.error) return parsed.error;
    } catch { /* not JSON — fall through to the raw body */ }
    return body || 'Could not change password';
  }
}

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];
customElements.define('change-password-modal', ChangePasswordModal);
