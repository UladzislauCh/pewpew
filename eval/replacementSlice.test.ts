/**
 * Replacement sound: decoding, limits, cancelling a stale decode.
 *
 * There used to be no way to test this — decoding lived in a component effect and
 * required a real `AudioContext`, which doesn't exist in Node. Here the caller
 * supplies the decoding method, and the slice only checks the result against limits,
 * so anything can be fed in.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { AudioLike } from '../src/domain/audio/audioTypes'
import { MEDIA_LIMITS, MediaValidationError } from '../src/domain/video/mediaKind'
import { DEFAULT_SILENCE_THRESHOLD_RATIO } from '../src/features/wizard/store/replacementSlice'
import { useWizardStore } from '../src/features/wizard/store/wizardStore'

const store = () => useWizardStore.getState()

/** A fake decoded audio buffer: exactly the fields the limits check. */
const audio = (over: Partial<AudioLike> = {}): AudioLike => ({
  sampleRate: 48_000,
  numberOfChannels: 2,
  duration: 1,
  length: 48_000,
  getChannelData: () => new Float32Array(0),
  ...over,
})

beforeEach(() => {
  useWizardStore.setState({
    replacementAudio: null,
    replacementBuffer: null,
    replacementError: null,
    isDecodingReplacement: false,
    selectedLibraryId: null,
    silenceThresholdRatio: DEFAULT_SILENCE_THRESHOLD_RATIO,
    _decodeRun: 0,
  })
})

describe('replacement sound', () => {
  it('accepts a sound within limits', async () => {
    await store().decodeReplacement(async () => audio())
    expect(store().replacementBuffer).not.toBeNull()
    expect(store().replacementError).toBeNull()
    expect(store().isDecodingReplacement).toBe(false)
  })

  it('rejects a too-long sound and names the reason with a code', async () => {
    await store().decodeReplacement(async () => audio({ duration: MEDIA_LIMITS.audio.maxDurationSec + 1 }))
    expect(store().replacementError).toBe('duration')
    expect(store().replacementBuffer).toBeNull()
  })

  it('rejects a too-heavy layout', async () => {
    await store().decodeReplacement(async () => audio({ numberOfChannels: 32 }))
    expect(store().replacementError).toBe('layout')
  })

  it('an unreadable file gives the parse-error code', async () => {
    await store().decodeReplacement(async () => {
      throw new Error('битый заголовок')
    })
    expect(store().replacementError).toBe('decode')
  })

  it('a too-long sound caught before decoding is also duration', async () => {
    await store().decodeReplacement(async () => {
      throw new MediaValidationError('audioDuration')
    })
    expect(store().replacementError).toBe('duration')
    expect(store().replacementBuffer).toBeNull()
  })

  it('a new pick cancels decoding of the previous one', async () => {
    let release: ((v: AudioLike) => void) | null = null
    const slow = store().decodeReplacement(() => new Promise((r) => (release = r)))
    // While the old decode is still running, the user picked a different sound.
    store().pickReplacement({ blob: new Blob([]), name: 'другой' })
    release!(audio())
    await slow
    // The result of a stale decode must not land in state.
    expect(store().replacementBuffer).toBeNull()
  })

  it('picking a sound resets the previous decode and error', async () => {
    await store().decodeReplacement(async () => audio({ duration: 999 }))
    expect(store().replacementError).toBe('duration')
    store().pickReplacement({ blob: new Blob([]), name: 'новый' }, 'boing')
    expect(store().replacementError).toBeNull()
    expect(store().replacementBuffer).toBeNull()
    expect(store().selectedLibraryId).toBe('boing')
  })

  it('a custom file clears the library-selection flag', () => {
    store().pickReplacement({ blob: new Blob([]), name: 'из библиотеки' }, 'bonk')
    store().pickReplacement({ blob: new Blob([]), name: 'свой' })
    expect(store().selectedLibraryId).toBeNull()
  })

  it('the silence-trim threshold changes and persists', () => {
    store().setSilenceThreshold(0.2)
    expect(store().silenceThresholdRatio).toBe(0.2)
  })
})
