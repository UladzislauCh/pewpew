/**
 * Mapping a reason code to text: every code has its own answer, nothing silently
 * falls through to a generic text.
 *
 * Not pinning down exact copy — that's `design`/`ui` territory, not this module's
 * contract. Pinning down invariants instead: a code produces non-empty text, and the
 * same limit (clip audio / replacement audio) returns the same text, not two
 * different ones for one rule.
 */
import { describe, expect, it } from 'vitest'
import type { ProjectProblem } from '../store/projectSlice'
import type { ReplacementProblem } from '../store/replacementSlice'
import { replacementProblemText, videoProblemText } from './problemCopy'

const VIDEO_PROBLEMS: readonly ProjectProblem[] = [
  'type',
  'size',
  'duration',
  'tooLarge',
  'audioTooHeavy',
  'noAudio',
  'analysis',
]

const REPLACEMENT_PROBLEMS: readonly ReplacementProblem[] = ['duration', 'layout', 'decode']

describe('videoProblemText', () => {
  it.each(VIDEO_PROBLEMS)('code %s gives non-empty text', (problem) => {
    expect(videoProblemText(problem).length).toBeGreaterThan(0)
  })

  it('clip audio and replacement audio share the same limit text', () => {
    // audioTooHeavy (clip) and layout (replacement audio) are the same sample-rate/channel limit.
    expect(videoProblemText('audioTooHeavy')).toBe(replacementProblemText('layout'))
  })
})

describe('replacementProblemText', () => {
  it.each(REPLACEMENT_PROBLEMS)('code %s gives non-empty text', (problem) => {
    expect(replacementProblemText(problem).length).toBeGreaterThan(0)
  })
})
