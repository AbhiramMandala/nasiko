import '/common/design-system/app-modal/app-modal.js';

import sheet from './confirm-dialog.css' with { type: 'css' };
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];

/**
 * Shows an in-app confirmation dialog (replaces browser `confirm()`).
 * Returns a Promise that resolves `true` on confirm, `false` on cancel/close.
 *
 * @param {object} opts
 * @param {string} opts.title - Modal heading
 * @param {string} opts.message - Body text (supports HTML)
 * @param {string} [opts.confirmLabel='Confirm'] - Primary button label
 * @param {string} [opts.cancelLabel='Cancel'] - Secondary button label
 * @param {boolean} [opts.danger=false] - Styles the confirm button as destructive
 */
export function confirmDialog({
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
}) {
  return new Promise((resolve) => {
    const modal = document.createElement('app-modal');
    // Scope root for confirm-dialog.css. The dialog's markup lives inside a
    // generic <app-modal>, so it needs a marker of its own to scope against —
    // scoping to `app-modal` would leak these rules into every other modal.
    modal.classList.add('confirm-dialog');
    modal.setAttribute('heading', title);

    modal.innerHTML = `
      <p class="confirm-dialog-body">${message}</p>
      <div data-slot="footer" class="confirm-dialog-footer">
        <button type="button" class="cancel-btn" data-role="cancel">${cancelLabel}</button>
        <button type="button" class="confirm-btn${danger ? ' danger' : ''}" data-role="confirm">${confirmLabel}</button>
      </div>
    `;

    document.body.appendChild(modal);
    let resolved = false;

    const cleanup = (result) => {
      if (resolved) return;
      resolved = true;
      modal.close();
      modal.remove();
      resolve(result);
    };

    modal.querySelector('[data-role="cancel"]').addEventListener('click', () => cleanup(false));
    modal.querySelector('[data-role="confirm"]').addEventListener('click', () => cleanup(true));
    modal.querySelector('dialog')?.addEventListener('close', () => cleanup(false));

    modal.open();
  });
}
