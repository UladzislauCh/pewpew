import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  buildPayload,
  firstEmptyField,
  firstInvalidField,
  TOPIC_FIELDS,
  validateFeedback,
  validateField,
  type FieldError,
  type FieldErrors,
} from './form'
import { sendFeedback, WEB3FORMS_ACCESS_KEY } from '../../shared/feedback/web3forms'
import {
  FEEDBACK_TOPICS,
  type FeedbackField,
  type FeedbackTopic,
} from '../../shared/store/feedbackSlice'
import { useSiteStore } from '../../shared/store/siteStore'
import { TopicSelect } from './TopicSelect'
import './FeedbackDialog.css'

type FieldPart = 'label' | 'placeholder'

/**
 * Field label key. The text and link fields have their own labels per topic: “What's wrong”
 * for markers, “What were you doing” for a breakage, “Link to the sound” vs “Where's the clip from”.
 */
function fieldKey(name: FeedbackField, part: FieldPart, topic: FeedbackTopic): string {
  switch (name) {
    case 'message':
      // “New sound” has no text field; the idea's label is borrowed only for copying.
      return `feedback.fields.message.${topic === 'sound' ? 'idea' : topic}.${part}`
    case 'link':
      return `feedback.fields.link.${topic === 'sound' ? 'sound' : 'marks'}.${part}`
    case 'soundName':
      return `feedback.fields.soundName.${part}`
    case 'email':
      return `feedback.fields.email.${part}`
  }
}

function helpKey(name: FeedbackField, topic: FeedbackTopic): string | null {
  if (name === 'email') return 'feedback.fields.email.help'
  if (name === 'link' && topic === 'marks') return 'feedback.fields.link.marks.help'
  return null
}

function errorKey(name: FeedbackField, error: FieldError): string {
  if (error === 'required') return `feedback.errors.required.${name}`
  return `feedback.errors.${error}`
}

function ErrorIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5v4.2M10 13.4v.1" />
    </svg>
  )
}

/**
 * The feedback popup. Mockup — `docs/design/mockups.html`, section 09.
 *
 * A NATIVE `<dialog>` WITH `showModal()`, not a custom layer. It traps Tab by itself,
 * makes the background inert for screen readers and delivers Esc as a `cancel` event —
 * exactly what the skill's rules require of a modal, without a single line of focus trap.
 *
 * Every way of closing — ×, Esc, click outside, “Close” after sending — converges on one
 * `close` event handler: that's where focus returns to the trigger and the scroll lock is lifted.
 */
export function FeedbackDialog() {
  const { t, i18n } = useTranslation()
  const isOpen = useSiteStore((s) => s.isFeedbackOpen)
  const topic = useSiteStore((s) => s.feedbackTopic)
  const draft = useSiteStore((s) => s.feedbackDraft)
  const status = useSiteStore((s) => s.feedbackStatus)
  const closeFeedback = useSiteStore((s) => s.closeFeedback)
  const setTopic = useSiteStore((s) => s.setFeedbackTopic)
  const updateDraft = useSiteStore((s) => s.updateFeedbackDraft)
  const setStatus = useSiteStore((s) => s.setFeedbackStatus)
  const clearDraft = useSiteStore((s) => s.clearFeedbackDraft)

  const baseId = useId()
  const titleId = `${baseId}-title`
  const resultTitleId = `${baseId}-result`
  const topicLabelId = `${baseId}-topic-label`

  const dialogRef = useRef<HTMLDialogElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const listOpenRef = useRef(false)
  const pressedOnBackdropRef = useRef(false)
  const botcheckRef = useRef<HTMLInputElement>(null)
  const submitRef = useRef<HTMLButtonElement>(null)
  const resultActionRef = useRef<HTMLButtonElement>(null)
  const fieldRefs = useRef<Partial<Record<FeedbackField, HTMLInputElement | HTMLTextAreaElement | null>>>({})
  /**
   * The field WE focused on open, as long as the person hasn't typed anything in it.
   *
   * Leaving it the first time isn't validated. Otherwise: open the form, click the topic
   * list — and under a field they never touched, “Write at least a few words” is already lit.
   */
  const autoFocusedRef = useRef<FeedbackField | null>(null)

  const [errors, setErrors] = useState<FieldErrors>({})

  const sending = status === 'sending'
  const showsResult = status === 'sent' || status === 'failed'

  // Open and close following the flag in the store.
  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (isOpen && !dialog.open) {
      const active = document.activeElement
      returnFocusRef.current = active instanceof HTMLElement ? active : null
      dialog.showModal()
      document.documentElement.classList.add('feedback-open')
      // Focus goes to the first empty field: the “Suggest a sound” entry lands the person
      // straight in the link, and someone returning to a draft — where they left off.
      const state = useSiteStore.getState()
      const target = firstEmptyField(state.feedbackTopic, state.feedbackDraft)
      const field = target ? fieldRefs.current[target] : null
      autoFocusedRef.current = field ? target : null
      ;(field ?? submitRef.current)?.focus()
    } else if (!isOpen && dialog.open) {
      dialog.close()
    }
  }, [isOpen])

  // A retry after “Didn't get through” starts from the error view, which has no submit
  // button: focus returns to it once the form is back on screen.
  useEffect(() => {
    if (isOpen && sending) submitRef.current?.focus()
  }, [isOpen, sending])

  // Send outcome: focus its button so the screen reader and keyboard end up where the eyes are.
  useEffect(() => {
    if (isOpen && showsResult) resultActionRef.current?.focus()
  }, [isOpen, showsResult, status])

  const handleClose = () => {
    document.documentElement.classList.remove('feedback-open')
    setErrors({})
    clearDraft()
    if (useSiteStore.getState().isFeedbackOpen) closeFeedback()
    const back = returnFocusRef.current
    returnFocusRef.current = null
    if (back && document.contains(back)) back.focus()
  }

  const send = async () => {
    const state = useSiteStore.getState()
    const payload = buildPayload(state.feedbackTopic, state.feedbackDraft, {
      accessKey: WEB3FORMS_ACCESS_KEY,
      // The topic in the message is always in Russian: it's read by one person, not by users.
      topicTitle: i18n.t(`feedback.topics.${state.feedbackTopic}.title`, { lng: 'ru' }),
      botcheck: botcheckRef.current?.checked ? 'true' : '',
    })
    // Focus moves to the button BEFORE the fields become disabled: otherwise it falls
    // to the page under the popup.
    submitRef.current?.focus()
    setStatus('sending')
    const result = await sendFeedback(payload)
    if (result === 'sent') {
      clearDraft()
      setStatus('sent')
    } else {
      setStatus('failed')
    }
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    if (sending) return
    const found = validateFeedback(topic, draft)
    setErrors(found)
    const first = firstInvalidField(topic, found)
    if (first) {
      fieldRefs.current[first]?.focus()
      return
    }
    void send()
  }

  // Leaving a field: required-ness and format are checked. The error is cleared here too —
  // if the person fixed the field but hasn't submitted yet.
  const onFieldBlur = (name: FeedbackField) => {
    if (autoFocusedRef.current === name) {
      autoFocusedRef.current = null
      return
    }
    const state = useSiteStore.getState()
    const error = validateField(state.feedbackTopic, state.feedbackDraft, name)
    setErrors((prev) => {
      // “Text or link” stays until submit or input — leaving the field doesn't clear it.
      if (prev[name] === 'oneOf') return prev
      if ((prev[name] ?? null) === error) return prev
      const next = { ...prev }
      if (error) next[name] = error
      else delete next[name]
      return next
    })
  }

  const onFieldChange = (name: FeedbackField, value: string) => {
    if (autoFocusedRef.current === name) autoFocusedRef.current = null
    updateDraft({ [name]: value })
    // The error clears as soon as the person starts fixing it — but isn't re-checked on
    // every keystroke: “typo in email” halfway through typing an address only gets in the way.
    setErrors((prev) => {
      if (!prev[name] && prev.message !== 'oneOf') return prev
      const next = { ...prev }
      delete next[name]
      if (next.message === 'oneOf' && (name === 'message' || name === 'link')) delete next.message
      return next
    })
  }

  
  const topicOptions = FEEDBACK_TOPICS.map((value) => ({
    value,
    label: t(`feedback.topics.${value}.title`),
    description: t(`feedback.topics.${value}.description`),
  }))

  const renderField = ({ name, required }: { name: FeedbackField; required: boolean }) => {
    const id = `${baseId}-${name}`
    const errorId = `${id}-error`
    const helpId = `${id}-help`
    const error = errors[name]
    const help = helpKey(name, topic)
    const describedBy = [error ? errorId : null, help ? helpId : null].filter(Boolean).join(' ')
    const className = [
      'feedback__control',
      name === 'message' ? 'feedback__control--area' : '',
      error ? 'feedback__control--invalid' : '',
    ].filter(Boolean).join(' ')
    const common = {
      id,
      className,
      value: draft[name],
      placeholder: t(fieldKey(name, 'placeholder', topic)),
      'aria-invalid': error ? true : undefined,
      'aria-required': required || undefined,
      'aria-describedby': describedBy || undefined,
    }

    return (
      <div className="feedback__field" key={name}>
        <label htmlFor={id} className="feedback__label">
          {t(fieldKey(name, 'label', topic))}
          {required && (
            <span className="feedback__req" aria-hidden="true">
              {' '}*
            </span>
          )}
        </label>
        {name === 'message' ? (
          <textarea
            {...common}
            ref={(el) => {
              fieldRefs.current[name] = el
            }}
            rows={4}
            onChange={(event) => onFieldChange(name, event.target.value)}
            onBlur={() => onFieldBlur(name)}
          />
        ) : (
          <input
            {...common}
            ref={(el) => {
              fieldRefs.current[name] = el
            }}
            type={name === 'email' ? 'email' : name === 'link' ? 'url' : 'text'}
            autoComplete={name === 'email' ? 'email' : 'off'}
            spellCheck={name === 'soundName'}
            onChange={(event) => onFieldChange(name, event.target.value)}
            onBlur={() => onFieldBlur(name)}
          />
        )}
        {error && (
          <p id={errorId} className="feedback__error" role="alert">
            <ErrorIcon />
            {t(errorKey(name, error))}
          </p>
        )}
        {help && (
          <p id={helpId} className="feedback__help">
            {t(help)}
          </p>
        )}
      </div>
    )
  }

  return (
    <dialog
      ref={dialogRef}
      className="feedback"
      aria-labelledby={showsResult ? resultTitleId : titleId}
      onClose={handleClose}
      onCancel={(event) => {
        if (listOpenRef.current) event.preventDefault()
      }}
      // A click outside counts only if both press and release happened on the backdrop:
      // otherwise selecting text in a field and ending past the popup's edge would close it.
      onPointerDown={(event) => {
        pressedOnBackdropRef.current = event.target === dialogRef.current
      }}
      onClick={(event) => {
        if (pressedOnBackdropRef.current && event.target === dialogRef.current) closeFeedback()
        pressedOnBackdropRef.current = false
      }}
    >
      <div className="feedback__panel">
        <div className="feedback__head">
          {!showsResult && (
            <h2 id={titleId} className="feedback__title">
              {t('feedback.title')}
            </h2>
          )}
          <button type="button" className="feedback__close" aria-label={t('feedback.close')} onClick={closeFeedback}>
            <svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M5 5l10 10M15 5L5 15" />
            </svg>
          </button>
        </div>

        {!showsResult && (
          <form className="feedback__body" noValidate onSubmit={onSubmit} aria-busy={sending || undefined}>
            <fieldset className="feedback__fieldset" disabled={sending}>
              <div className="feedback__field">
                <span id={topicLabelId} className="feedback__label">
                  {t('feedback.topicLabel')}
                </span>
                <TopicSelect
                  id={`${baseId}-topic`}
                  labelId={topicLabelId}
                  value={topic}
                  options={topicOptions}
                  disabled={sending}
                  onChange={(next) => {
                    setTopic(next)
                    setErrors({})
                  }}
                  onOpenChange={(open) => {
                    listOpenRef.current = open
                  }}
                />
              </div>

              {TOPIC_FIELDS[topic].map(renderField)}

              {topic === 'sound' && (
                <div className="feedback__hint">
                  <svg width="15" height="15" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <circle cx="10" cy="10" r="7" />
                    <path d="M10 9.2v4M10 6.6v.1" />
                  </svg>
                  <p>{t('feedback.soundHint')}</p>
                </div>
              )}

              {/* Bot trap: a person never sees this field and won't fill it in. */}
              <input ref={botcheckRef} className="feedback__botcheck" type="checkbox" name="botcheck" tabIndex={-1} aria-hidden="true" />
            </fieldset>

            <button
              ref={submitRef}
              type="submit"
              className={sending ? 'feedback__submit feedback__submit--busy' : 'feedback__submit'}
              aria-disabled={sending || undefined}
            >
              {sending && <span className="feedback__spinner" aria-hidden="true" />}
              {sending ? t('feedback.sending') : t('feedback.submit')}
            </button>
          </form>
        )}

        {status === 'sent' && (
          <div className="feedback__body feedback__result">
            <div className="feedback__mark feedback__mark--ok" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <path d="M5 12.5l5 5 9-10" />
              </svg>
            </div>
            <h2 id={resultTitleId} className="feedback__result-title">
              {t('feedback.sent.title')}
            </h2>
            <p className="feedback__result-lead" role="status">
              {t('feedback.sent.lead')}
            </p>
            <button ref={resultActionRef} type="button" className="feedback__submit" onClick={closeFeedback}>
              {t('feedback.sent.close')}
            </button>
          </div>
        )}

        {status === 'failed' && (
          <div className="feedback__body feedback__result">
            <div className="feedback__mark feedback__mark--error" aria-hidden="true">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square">
                <path d="M12 4v9.5M12 18.5v0.01" />
              </svg>
            </div>
            <h2 id={resultTitleId} className="feedback__result-title">
              {t('feedback.failed.title')}
            </h2>
            <p className="feedback__result-lead" role="alert">
              {t('feedback.failed.lead')}
            </p>
            <button ref={resultActionRef} type="button" className="feedback__submit" onClick={() => void send()}>
              {t('feedback.failed.retry')}
            </button>
          </div>
        )}
      </div>
    </dialog>
  )
}
