/**
 * Public API of the wizard — ADR 0001, 0006.
 *
 * Layout styles are imported here, not in `App.tsx`: from outside, the feature is
 * visible only through this file, and the wizard's markup should come along with it.
 */
import './WizardLayout.css'

export { WizardApp } from './WizardApp'
export { resetWizard, useWizardStore } from './store/wizardStore'

/**
 * Upload-limit texts are exported for the “how it works” page: it promises the
 * same limits the wizard checks, and a second list of them would drift from the first.
 */
export { getMediaLimitCopy } from './model/mediaLimits'
