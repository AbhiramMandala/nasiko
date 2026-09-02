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

// Mirrors `validate_password` in oss/auth/src/lib.rs. Client-side only, for
// fast feedback — the server enforces the policy regardless, and its slug is
// what the user actually sees if these ever drift.
const MIN_PASSWORD_LEN = 12;
const MAX_PASSWORD_LEN = 64;
const MAX_PASSWORD_BYTES = 72;

/// Returns the first unmet rule, or null. Order matches the server so the
/// client and the API complain about the same thing first.
function passwordPolicyError(pw) {
  // `TextEncoder` counts bytes the way bcrypt does; `.length` would count
  // UTF-16 units and let a multibyte password past the truncation limit.
  if (new TextEncoder().encode(pw).length > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${MAX_PASSWORD_BYTES} bytes`;
  }
  const chars = [...pw];
  if (chars.length < MIN_PASSWORD_LEN) return `Password must be at least ${MIN_PASSWORD_LEN} characters`;
  if (chars.length > MAX_PASSWORD_LEN) return `Password must be at most ${MAX_PASSWORD_LEN} characters`;
  // Unicode-aware, matching the server: a non-Latin password is judged by the
  // same rules rather than refused for lacking ASCII.
  if (!/\p{Ll}/u.test(pw)) return 'Password must contain a lowercase letter';
  if (!/\p{Lu}/u.test(pw)) return 'Password must contain an uppercase letter';
  if (!/\p{N}/u.test(pw)) return 'Password must contain a digit';
  if (!/[^\p{L}\p{N}]/u.test(pw)) return 'Password must contain a symbol';
  return null;
}

const POLICY_HINT = `${MIN_PASSWORD_LEN}-${MAX_PASSWORD_LEN} characters, with an uppercase letter, `
  + 'a lowercase letter, a digit and a symbol.';

// What each field's hint row shows when it is not in the error state — so
// clearing an error restores the guidance instead of leaving a blank row.
const RESTING_HINTS = { '#cp-new': POLICY_HINT };

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
          <app-input id="cp-current" label="Current password" type="password" reveal
            autocomplete="current-password" required
            placeholder="the password you sign in with now"></app-input>
          <app-input id="cp-new" label="New password" type="password" reveal
            autocomplete="new-password" required hint="${POLICY_HINT}"
            placeholder="a new, unused password"></app-input>
          <app-input id="cp-confirm" label="Confirm new password" type="password" reveal
            autocomplete="new-password" required
            placeholder="retype the new password"></app-input>
          <p class="hint">Your other sessions will be signed out.</p>
        </div>
        <div data-slot="footer">
          <app-button variant="tertiary" size="md" id="cp-cancel">Cancel</app-button>
          <app-button variant="primary" size="md" id="cp-save">Change password</app-button>
        </div>
      </app-modal>`;

    this.#modal = this.querySelector('#cp-modal');
    this.querySelector('#cp-cancel').addEventListener('click', () => this.#modal.close());
    this.querySelector('#cp-save').addEventListener('click', () => this.#submit());

    this.querySelectorAll('app-input').forEach((input) => {
      // Enter anywhere in the form submits, matching native form behaviour —
      // except on app-input's own reveal button, where Enter is the click that
      // unmasks the field and submitting instead would be the opposite of what
      // the key press asked for.
      input.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' || e.target.tagName !== 'INPUT') return;
        e.preventDefault();
        this.#submit();
      });
      // Clear the field's error the moment the user acts on it, so the message
      // always describes the current value rather than the one that failed.
      input.addEventListener('input', () => this.#setFieldError(`#${input.id}`, null));
    });
  }

  /** Paints one field with app-input's `error` state, or restores its resting
   *  hint when `message` is null. Validation belongs on the field that is wrong;
   *  toasts stay for whole-request failures the fields can't express. */
  #setFieldError(selector, message) {
    const field = this.querySelector(selector);
    if (message) {
      field.setAttribute('state', 'error');
      field.setAttribute('hint', message);
      return;
    }
    field.removeAttribute('state');
    const resting = RESTING_HINTS[selector];
    if (resting) field.setAttribute('hint', resting);
    else field.removeAttribute('hint');
  }

  open() {
    this.connectedCallback();
    for (const id of ['#cp-current', '#cp-new', '#cp-confirm']) {
      this.querySelector(id).value = '';
      this.#setFieldError(id, null);
    }
    this.#modal.open();
    this.querySelector('#cp-current').focus?.();
  }

  async #submit() {
    const current_password = this.querySelector('#cp-current').value;
    const new_password = this.querySelector('#cp-new').value;
    const confirm = this.querySelector('#cp-confirm').value;

    if (!current_password) {
      this.#setFieldError('#cp-current', 'Enter your current password'); return;
    }
    if (!new_password) {
      this.#setFieldError('#cp-new', 'Enter a new password'); return;
    }
    const policyError = passwordPolicyError(new_password);
    if (policyError) { this.#setFieldError('#cp-new', policyError); return; }
    if (new_password === current_password) {
      this.#setFieldError('#cp-new', 'New password must differ from the current one'); return;
    }
    if (new_password !== confirm) {
      this.#setFieldError('#cp-confirm', 'New passwords do not match'); return;
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
      if (!res.ok) { await this.#reportError(res); return; }

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

  /** The server sends `{"error", "code"}` per API_CONVENTIONS §2, and its `code`
   *  says which field is at fault — so a rejected change lands on that field in
   *  app-input's error state, the same as client-side validation. Anything the
   *  fields can't own (no local password, 5xx, an unexpected body shape) stays a
   *  toast; the raw body is the last fallback so it still surfaces something. */
  async #reportError(res) {
    const body = await res.text();
    let error = '';
    let code = '';
    try {
      const parsed = JSON.parse(body);
      error = parsed?.error ?? '';
      code = parsed?.code ?? '';
    } catch { /* not JSON — fall through to the raw body */ }
    // The API's messages are lowercase sentence fragments; the hint row reads
    // as a sentence next to the client-side ones, so capitalise the first letter.
    const raw = error || body || 'Could not change password';
    const message = raw.charAt(0).toUpperCase() + raw.slice(1);

    if (code === 'current_password_incorrect') {
      this.#setFieldError('#cp-current', message);
    } else if (code.startsWith('password_')) {
      this.#setFieldError('#cp-new', message);
    } else {
      showToast(message);
    }
  }
}

document.adoptedStyleSheets = [...document.adoptedStyleSheets, styles];
customElements.define('change-password-modal', ChangePasswordModal);
