/**
 * Feedback form rules without DOM or React: topic fields, validation, request body.
 *
 * Kept apart from the component for one reason: the “what's required for which topic”
 * rules must be checked by a test, not by eye in a browser. Mockup — `docs/design/mockups.html`,
 * section 09.
 *
 * The draft vocabulary (topics, fields, `EMPTY_DRAFT`) lives in `shared/store/feedbackSlice`:
 * the store needs it, and the store can't import a feature. The rules are needed only
 * by the form, so they live here.
 */

import type {
  FeedbackDraft,
  FeedbackField,
  FeedbackTopic,
} from '../../shared/store/feedbackSlice'

interface FieldSpec {
  name: FeedbackField
  required: boolean
}

/** Which fields a topic shows. The order here is the on-screen order and the focus order. */
export const TOPIC_FIELDS: Record<FeedbackTopic, readonly FieldSpec[]> = {
  marks: [
    { name: 'message', required: false },
    { name: 'link', required: false },
    { name: 'email', required: false },
  ],
  broken: [
    { name: 'message', required: true },
    { name: 'email', required: false },
  ],
  sound: [
    { name: 'link', required: true },
    { name: 'soundName', required: false },
    { name: 'email', required: false },
  ],
  idea: [
    { name: 'message', required: true },
    { name: 'email', required: false },
  ],
  partnership: [
    { name: 'message', required: true },
    { name: 'email', required: false },
  ],
}

/**
 * “Inaccurate markers”: each field is optional on its own, but the message can't go out empty.
 *
 * The mockup said “all optional” here — back when technical context was attached to the
 * message automatically, and even an empty one said which clip and which path went wrong.
 * That context was dropped after the first iteration, and a message with just a topic says nothing.
 */
const AT_LEAST_ONE: Partial<Record<FeedbackTopic, readonly FeedbackField[]>> = {
  marks: ['message', 'link'],
}

export type FieldError = 'required' | 'oneOf' | 'notLink' | 'notEmail'
export type FieldErrors = Partial<Record<FeedbackField, FieldError>>

/** A link without a protocol is still a link: people paste “youtu.be/…” like that. */
const LINK_RE = /^(https?:\/\/)?[^\s/.]+(\.[^\s/.]+)+(\/\S*)?$/i
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function visibleFields(topic: FeedbackTopic): FeedbackField[] {
  return TOPIC_FIELDS[topic].map((f) => f.name)
}

/**
 * Validation of ONE field — what runs on leaving it (blur).
 *
 * The “text OR link” rule for “Inaccurate markers” is not part of this, on purpose.
 * It's about two fields at once: someone left the empty text to paste a link into
 * the next field — scolding them for that is premature. It's checked only on submit.
 */
export function validateField(
  topic: FeedbackTopic,
  draft: FeedbackDraft,
  name: FeedbackField,
): FieldError | null {
  const spec = TOPIC_FIELDS[topic].find((f) => f.name === name)
  if (!spec) return null
  const v = draft[name].trim()
  if (!v) return spec.required ? 'required' : null
  if (name === 'link' && !LINK_RE.test(v)) return 'notLink'
  if (name === 'email' && !EMAIL_RE.test(v)) return 'notEmail'
  return null
}

export function validateFeedback(topic: FeedbackTopic, draft: FeedbackDraft): FieldErrors {
  const errors: FieldErrors = {}
  for (const { name } of TOPIC_FIELDS[topic]) {
    const error = validateField(topic, draft, name)
    if (error) errors[name] = error
  }

  const oneOf = AT_LEAST_ONE[topic]
  if (oneOf && oneOf.every((name) => !draft[name].trim())) errors[oneOf[0]] = 'oneOf'

  return errors
}

/** The first invalid field in screen order — focus goes there after a failed submit. */
export function firstInvalidField(topic: FeedbackTopic, errors: FieldErrors): FeedbackField | null {
  return visibleFields(topic).find((name) => errors[name]) ?? null
}

/** The first empty field — focus lands there on open. */
export function firstEmptyField(topic: FeedbackTopic, draft: FeedbackDraft): FeedbackField | null {
  return visibleFields(topic).find((name) => !draft[name].trim()) ?? null
}

/** Field names in the message. English and stable: messages are later searched and filtered by them. */
const PAYLOAD_KEY: Record<FeedbackField, string> = {
  message: 'message',
  link: 'link',
  soundName: 'sound_name',
  email: 'email',
}

/**
 * Web3Forms request body.
 *
 * ONLY fields visible in the chosen topic are sent: the draft is shared, and without the
 * filter a message about an idea would drag along a link left behind under “New sound”.
 * Empty ones aren't sent at all. Web3Forms uses `email` as the reply-to address — exactly what we want.
 */
export function buildPayload(
  topic: FeedbackTopic,
  draft: FeedbackDraft,
  options: { accessKey: string; topicTitle: string; botcheck: string },
): Record<string, string> {
  const payload: Record<string, string> = {
    access_key: options.accessKey,
    subject: `pewpew · ${options.topicTitle}`,
    from_name: 'pewpew',
    topic: options.topicTitle,
    botcheck: options.botcheck,
  }
  for (const name of visibleFields(topic)) {
    const v = draft[name].trim()
    if (v) payload[PAYLOAD_KEY[name]] = v
  }
  return payload
}
