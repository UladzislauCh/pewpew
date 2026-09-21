import { create } from 'zustand'
import { createFeedbackSlice, type FeedbackState } from './feedbackSlice'
import { createMenuSlice, type MenuState } from './menuSlice'

/**
 * The SITE store, separate from the wizard store.
 *
 * Header and footer live outside the wizard: they show on the FAQ and on the error page,
 * where no video is being analysed. Put their state into `wizardStore` and the FAQ page
 * drags in markers, the replacement sound and export — half the app for a single
 * “menu is open” flag.
 *
 * Hence two stores instead of one. The slices are built the same way; the split runs
 * along the “site shell” vs “wizard” boundary.
 */
export type SiteStore = MenuState & FeedbackState

export const useSiteStore = create<SiteStore>()((...a) => ({
  ...createMenuSlice(...a),
  ...createFeedbackSlice(...a),
}))
