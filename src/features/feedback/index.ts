/**
 * Public API of the feedback feature — ADR 0001, 0007.
 *
 * Only the dialog is exposed. It is opened via `openFeedback` from
 * `shared/store/siteStore`: callers are everywhere — header, footer, FAQ, error page
 * and the marker-editing step — and the feature knows nothing about them.
 */
export { FeedbackDialog } from './FeedbackDialog'
