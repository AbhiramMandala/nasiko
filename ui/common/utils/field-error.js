/**
 * Put a validation message on the control it belongs to.
 *
 * The design system already renders field errors: `state="error"` reddens the
 * control's border and `hint` carries the message in its hint row, styled by
 * the component's own sheet (app-input.css `.is-error`). Pages were instead
 * writing the message into a hand-rolled `.form-error` line next to the field,
 * so the control stayed in its default state and the text got page-local
 * styling — the "the component isn't applying" symptom.
 *
 * Reserve `.form-error` for failures with no single field to blame (a rejected
 * save, a failed probe). Anything a user can fix in one control belongs here.
 *
 * Setting either attribute re-renders the control, which carries the typed
 * value and focus across, so this is safe to call mid-edit.
 *
 * @param {Element|null} field  An <app-input>/<app-select>/<app-search>.
 * @param {string|null} message Message to show, or null/'' to clear.
 */
export function setFieldError(field, message) {
  if (!field) return;
  if (message) {
    field.setAttribute('state', 'error');
    field.setAttribute('hint', message);
    // The message is about what's in the control, so editing it retracts the
    // message — otherwise the error sits there, red, until the next submit.
    // `once` drops the listener after one edit; a later re-clear is a no-op.
    field.addEventListener('input', () => setFieldError(field, null), { once: true });
  } else {
    field.removeAttribute('state');
    field.removeAttribute('hint');
  }
}

/** Clear the error state on every passed control. */
export function clearFieldErrors(...fields) {
  for (const f of fields) setFieldError(f, null);
}
