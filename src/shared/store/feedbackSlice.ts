import type { StateCreator } from 'zustand'

export type FeedbackStatus = 'editing' | 'sending' | 'sent' | 'failed'

/**
 * THE DRAFT VOCABULARY LIVES HERE, the rules live in the feature.
 *
 * The store needs exactly this: which topics exist, which fields make up a draft and what
 * an empty one looks like. “What's required for which topic”, validation and the message
 * body are none of the store's business and live in `features/feedback/form.ts`. The slice
 * used to pull in that whole file — which is why form logic sat in `shared`.
 */
export const FEEDBACK_TOPICS = ['marks', 'broken', 'sound', 'idea', 'partnership'] as const
export type FeedbackTopic = (typeof FEEDBACK_TOPICS)[number]

/**
 * ONE draft for all topics, not one per topic.
 *
 * Someone starts writing under “Not working”, realises it's more like “Inaccurate markers”
 * and switches the topic — the text and email must come along. Fields the new topic
 * doesn't need are simply hidden and not sent.
 */
export interface FeedbackDraft {
  message: string
  link: string
  soundName: string
  email: string
}

export type FeedbackField = keyof FeedbackDraft

export const EMPTY_DRAFT: FeedbackDraft = { message: '', link: '', soundName: '', email: '' }

/**
 * The feedback popup.
 *
 * In the site store, not component state: it's opened from everywhere — header,
 * footer, FAQ, error pages, the marker-editing screen — and each place needs a single
 * “open with this topic” action, with no callbacks through the whole tree.
 *
 * THE DRAFT SURVIVES CLOSING. ×, Esc and a click outside close the popup, but what was
 * written stays until a successful send: asking “really close?” costs more than keeping
 * a couple of lines. The draft is cleared only by a “sent” response.
 */
export interface FeedbackState {
  isFeedbackOpen: boolean
  feedbackTopic: FeedbackTopic
  feedbackDraft: FeedbackDraft
  feedbackStatus: FeedbackStatus
  openFeedback: (topic: FeedbackTopic) => void
  closeFeedback: () => void
  setFeedbackTopic: (topic: FeedbackTopic) => void
  updateFeedbackDraft: (patch: Partial<FeedbackDraft>) => void
  setFeedbackStatus: (status: FeedbackStatus) => void
  clearFeedbackDraft: () => void
}

export const createFeedbackSlice: StateCreator<FeedbackState, [], [], FeedbackState> = (set) => ({
  isFeedbackOpen: false,
  feedbackTopic: 'idea',
  feedbackDraft: EMPTY_DRAFT,
  feedbackStatus: 'editing',
  openFeedback: (topic) =>
    set((s) => ({
      isFeedbackOpen: true,
      feedbackTopic: topic,
      // Don't show the previous send's outcome on a new open: “Sent” has already been said,
      // and after “Didn't get through” the person returns to the form with the draft intact.
      // An in-flight send is left alone — its response is still coming.
      feedbackStatus: s.feedbackStatus === 'sending' ? 'sending' : 'editing',
    })),
  closeFeedback: () => set({ isFeedbackOpen: false }),
  setFeedbackTopic: (topic) => set({ feedbackTopic: topic }),
  updateFeedbackDraft: (patch) => set((s) => ({ feedbackDraft: { ...s.feedbackDraft, ...patch } })),
  setFeedbackStatus: (status) => set({ feedbackStatus: status }),
  clearFeedbackDraft: () => set({ feedbackDraft: EMPTY_DRAFT }),
})
