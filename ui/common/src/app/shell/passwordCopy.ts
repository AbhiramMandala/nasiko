/**
 * The account menu's Change password dialog (nasiko-cloud-rs ui/common/features/change-password-modal.js). Apart from
 * the shell's copy.ts because the dialog loads on first open: its strings stay out of the shell budget.
 */
export const passwordCopy = {
  title: 'Change password',
  current: 'Current password',
  currentPlaceholder: 'the password you sign in with now',
  next: 'New password',
  nextPlaceholder: 'a new, unused password',
  confirm: 'Confirm new password',
  confirmPlaceholder: 'retype the new password',
  policy: (min: number, max: number) =>
    `${min}-${max} characters, with an uppercase letter, a lowercase letter, a digit and a symbol.`,
  others: 'Your other sessions will be signed out.',
  cancel: 'Cancel',
  submit: 'Change password',
  submitting: 'Changing…',
  currentRequired: 'Enter your current password',
  nextRequired: 'Enter a new password',
  problem: {
    bytes: 'Password must be at most 72 bytes',
    short: (min: number) => `Password must be at least ${min} characters`,
    long: (max: number) => `Password must be at most ${max} characters`,
    lowercase: 'Password must contain a lowercase letter',
    uppercase: 'Password must contain an uppercase letter',
    digit: 'Password must contain a digit',
    symbol: 'Password must contain a symbol',
  },
  same: 'New password must differ from the current one',
  mismatch: 'New passwords do not match',
  changed: 'Password changed. Your other sessions have been signed out.',
  failed: 'Could not change password',
  unreachable: 'Could not reach the server. Try again.',
}
