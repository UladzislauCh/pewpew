import { describe, expect, it } from 'vitest'
import { EMPTY_DRAFT, type FeedbackDraft } from '../../shared/store/feedbackSlice'
import { buildPayload, firstEmptyField, firstInvalidField, validateFeedback, validateField } from './form'

const draft = (patch: Partial<FeedbackDraft>): FeedbackDraft => ({ ...EMPTY_DRAFT, ...patch })

describe('validateFeedback', () => {
  it('a new sound without a link does not submit', () => {
    expect(validateFeedback('sound', EMPTY_DRAFT)).toEqual({ link: 'required' })
  })

  it('new sound: a link without a protocol is still a link', () => {
    expect(validateFeedback('sound', draft({ link: 'youtu.be/abc123' }))).toEqual({})
    expect(validateFeedback('sound', draft({ link: 'просто слово' }))).toEqual({ link: 'notLink' })
  })

  it('idea and partnership require text, whitespace does not count', () => {
    expect(validateFeedback('idea', draft({ message: '   ' }))).toEqual({ message: 'required' })
    expect(validateFeedback('partnership', draft({ message: 'реклама' }))).toEqual({})
  })

  it('marks: text OR a link is enough, empty is not allowed', () => {
    expect(validateFeedback('marks', EMPTY_DRAFT)).toEqual({ message: 'oneOf' })
    expect(validateFeedback('marks', draft({ link: 'https://www.tiktok.com/@a/video/1' }))).toEqual({})
    expect(validateFeedback('marks', draft({ message: 'мимо' }))).toEqual({})
  })

  it('email is optional, but a typo does not pass', () => {
    expect(validateFeedback('broken', draft({ message: 'зависло' }))).toEqual({})
    expect(validateFeedback('broken', draft({ message: 'зависло', email: 'me@mail' }))).toEqual({
      email: 'notEmail',
    })
  })

  it('fields from another topic are not validated', () => {
    expect(validateFeedback('idea', draft({ message: 'ок', link: 'не ссылка' }))).toEqual({})
  })
})

describe('validateField — validation on field blur', () => {
  it('an empty required field is an error, an empty optional one is not', () => {
    expect(validateField('sound', EMPTY_DRAFT, 'link')).toBe('required')
    expect(validateField('sound', EMPTY_DRAFT, 'soundName')).toBeNull()
    expect(validateField('idea', draft({ message: '  ' }), 'message')).toBe('required')
  })

  it('link and email format', () => {
    expect(validateField('marks', draft({ link: 'не ссылка' }), 'link')).toBe('notLink')
    expect(validateField('marks', draft({ link: '' }), 'link')).toBeNull()
    expect(validateField('idea', draft({ email: 'me@mail' }), 'email')).toBe('notEmail')
    expect(validateField('idea', draft({ email: 'me@mail.com' }), 'email')).toBeNull()
  })

  it('"text or link" is not checked on blur — only on submit', () => {
    expect(validateField('marks', EMPTY_DRAFT, 'message')).toBeNull()
    expect(validateFeedback('marks', EMPTY_DRAFT)).toEqual({ message: 'oneOf' })
  })

  it('a field from another topic is not validated', () => {
    expect(validateField('idea', draft({ link: 'не ссылка' }), 'link')).toBeNull()
  })
})

describe('focus', () => {
  it('after an error — the first invalid field in screen order', () => {
    const errors = validateFeedback('sound', draft({ email: 'x@' }))
    expect(firstInvalidField('sound', errors)).toBe('link')
  })

  it('on open — the first empty field', () => {
    expect(firstEmptyField('marks', draft({ message: 'мимо' }))).toBe('link')
    expect(firstEmptyField('idea', draft({ message: 'а', email: 'a@b.c' }))).toBeNull()
  })
})

describe('buildPayload', () => {
  const options = { accessKey: 'KEY', topicTitle: 'Идея или отзыв', botcheck: '' }

  it('sends only visible, non-empty, trimmed fields for the topic', () => {
    const payload = buildPayload('idea', draft({ message: '  классно  ', link: 'забытая', email: '' }), options)
    expect(payload).toEqual({
      access_key: 'KEY',
      subject: 'pewpew · Идея или отзыв',
      from_name: 'pewpew',
      topic: 'Идея или отзыв',
      botcheck: '',
      message: 'классно',
    })
  })

  it('the sound name is sent under a stable key', () => {
    const payload = buildPayload('sound', draft({ link: 'x.com/a', soundName: 'Bruh' }), options)
    expect(payload.sound_name).toBe('Bruh')
    expect(payload.link).toBe('x.com/a')
  })
})
