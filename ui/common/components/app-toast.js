/**
 * Re-export from utils/toast.js — the canonical home of the toast manager.
 *
 * This file exists solely so existing `import … from '…/app-toast.js'` paths
 * keep working. New code should import from `utils/toast.js` directly.
 *
 * @deprecated Import from '../utils/toast.js' instead.
 */
export { toast, showToast } from '../utils/toast.js';
