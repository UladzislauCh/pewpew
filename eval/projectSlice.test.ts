/**
 * Project: picking a clip, media parsing, cancelling a stale parse, and the file URL.
 *
 * This all used to live in two component effects and required mediabunny with
 * `AudioContext`. Here the caller supplies the parsing method, and the slice is only
 * responsible for state.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AudioLike } from '../src/domain/audio/audioTypes'
import type { MediaAnalysis } from '../src/domain/video/mediaTypes'
import { MEDIA_LIMITS, MediaValidationError } from '../src/domain/video/mediaKind'
import { useWizardStore } from '../src/features/wizard/store/wizardStore'

const store = () => useWizardStore.getState()

let created: string[] = []
let revoked: string[] = []

/** There's no project without audio (see the header of `projectSlice.ts`), so it's present by default. */
const fakeAudioBuffer = (): AudioLike => ({
  sampleRate: 48_000,
  numberOfChannels: 2,
  duration: 10,
  length: 480_000,
  getChannelData: () => new Float32Array(0),
})

const analysis = (over: Partial<MediaAnalysis> = {}): MediaAnalysis => ({
  duration: 10,
  video: null,
  audio: null,
  audioBuffer: fakeAudioBuffer(),
  ...over,
})

const file = (name = 'clip.mp4') => new File([new Blob([])], name, { type: 'video/mp4' })

beforeEach(() => {
  created = []
  revoked = []
  let n = 0
  globalThis.URL.createObjectURL = vi.fn(() => {
    const url = `blob:clip/${++n}`
    created.push(url)
    return url
  })
  globalThis.URL.revokeObjectURL = vi.fn((url: string) => void revoked.push(url))
  useWizardStore.setState({
    videoFile: null,
    videoUrl: null,
    mediaAnalysis: null,
    analysisProblem: null,
    isAnalyzing: false,
    _analyzeRun: 0,
  })
})

describe('project', () => {
  it('picking a clip creates a URL for the player', () => {
    store().setVideoFile(file())
    expect(store().videoUrl).toBe(created[0])
  })

  it('switching clips releases the previous URL', () => {
    store().setVideoFile(file('первый.mp4'))
    const first = store().videoUrl
    store().setVideoFile(file('второй.mp4'))
    expect(revoked).toContain(first)
    expect(store().videoUrl).not.toBe(first)
  })

  it('parsing sets the result and clears the busy flag', async () => {
    await store().analyzeProject(async () => analysis())
    expect(store().mediaAnalysis).not.toBeNull()
    expect(store().isAnalyzing).toBe(false)
    expect(store().analysisProblem).toBeNull()
  })

  it('a too-long clip is rejected with a code, not text', async () => {
    await store().analyzeProject(async () =>
      analysis({ duration: MEDIA_LIMITS.video.maxDurationSec + 1 }),
    )
    expect(store().analysisProblem).toBe('duration')
    expect(store().mediaAnalysis).toBeNull()
  })

  it('an unreadable container gives the parse-error code', async () => {
    await store().analyzeProject(async () => {
      throw new Error('битый контейнер')
    })
    expect(store().analysisProblem).toBe('analysis')
  })

  it('a clip with no audio track is rejected with code noAudio', async () => {
    await store().analyzeProject(async () => analysis({ audioBuffer: null }))
    expect(store().analysisProblem).toBe('noAudio')
    expect(store().mediaAnalysis).toBeNull()
  })

  it('too large a resolution gives code tooLarge from demuxing', async () => {
    await store().analyzeProject(async () => {
      throw new MediaValidationError('videoDisplaySize')
    })
    expect(store().analysisProblem).toBe('tooLarge')
    expect(store().mediaAnalysis).toBeNull()
  })

  it('a new clip cancels the previous parse', async () => {
    let release: ((v: MediaAnalysis) => void) | null = null
    const slow = store().analyzeProject(() => new Promise((r) => (release = r)))
    store().setVideoFile(file('другой.mp4'))
    release!(analysis())
    await slow
    // The result of a stale parse must not land in state.
    expect(store().mediaAnalysis).toBeNull()
  })

  it('resetting the project releases the URL and clears everything', () => {
    store().setVideoFile(file())
    const url = store().videoUrl
    store().clearProject()
    expect(revoked).toContain(url)
    expect(store()).toMatchObject({ videoFile: null, videoUrl: null, mediaAnalysis: null })
  })
})
