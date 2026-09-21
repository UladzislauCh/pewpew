/**
 * The sound that replaces shots: selection, decoded buffer, decode errors.
 *
 * WHAT DIDN'T MOVE HERE AND WHY. The decoding effect in the wizard did three different jobs
 * at once: decoded the sound, drove the screen overlay and moved to the next step itself
 * when decoding succeeded. Only the first one is here. The overlay and the transition stayed
 * in the wizard — otherwise the store would start driving navigation, which is exactly the
 * line beyond which it stops being testable.
 *
 * HOW TO DECODE is supplied by the caller, the same trick as in the export slice:
 * Node has no `AudioContext`, and without this a test of the limit checks would be impossible.
 * The limits THEMSELVES, though, are checked here: they're pure functions and belong next
 * to the state they define.
 *
 * BOUNDARY: the reason CODE is stored, not text. Not out of purism — `mediaLimits` pulls in
 * i18n, which pulls in `document`, and the store would stop running in Node with its
 * tests. The pure checks live separately in `mediaKind`, and that's what we use.
 * The component supplies the text.
 */
import type { StateCreator } from 'zustand'
import type { AudioLike } from '../../../domain/audio/audioTypes'
import {
  isAudioDurationAllowed,
  isAudioLayoutAllowed,
  isMediaValidationError,
  type MediaValidationCode,
} from '../../../domain/video/mediaKind'
import type { AudioAsset } from '../model/audioAsset'

/**
 * How to get the decoded sound. Returns `null` if decoding was cancelled.
 *
 * `AudioLike`, not `AudioBuffer`: the Node project has no DOM types, and the store is
 * checked there too, with its tests. A real `AudioBuffer` satisfies this type as is —
 * that's what it was introduced for.
 */
export type DecodeRun = () => Promise<AudioLike | null>

/**
 * Why the sound was rejected. The component picks text by code — see the header on the boundary.
 *
 * `duration` — longer than allowed; `layout` — too heavy in sample rate or channels;
 * `decode` — the file couldn't be decoded at all.
 */
export type ReplacementProblem = 'duration' | 'layout' | 'decode'

/**
 * Probe rejection code → sound rejection reason.
 *
 * Limits are checked TWICE: by a cheap probe before decoding (it throws an exception
 * with a code) and on the finished buffer right here. Without this table the first check
 * said exactly the same as a total decode failure — “the sound didn't open”, when in
 * fact it opened fine and was simply longer than allowed.
 *
 * The table is EXHAUSTIVE for the same reason as in the project slice: a new code must break
 * the build, not quietly turn into “didn't open”.
 */
const PROBE_PROBLEM: Record<MediaValidationCode, ReplacementProblem> = {
  audioDuration: 'duration',
  audioLayout: 'layout',
  // Video codes are never thrown on this path: only the replacement sound comes here.
  videoDuration: 'decode',
  videoDisplaySize: 'decode',
  noAudioTrack: 'decode',
}

export interface ReplacementSlice {
  /** The chosen file: what to show and what to decode. */
  replacementAudio: AudioAsset | null
  /** The decoded sound. `null` until decoded or if decoding failed. */
  replacementBuffer: AudioLike | null
  /** Rejection reason code, not text. */
  replacementError: ReplacementProblem | null
  isDecodingReplacement: boolean
  /** Which library sound is selected. `null` — own file or recording. */
  selectedLibraryId: string | null
  /** How deep to trim silence at the edges of the sound. */
  silenceThresholdRatio: number

  /** Pick a sound. The previous decoded buffer and error are cleared immediately. */
  pickReplacement: (asset: AudioAsset | null, libraryId?: string | null) => void
  /** Decode the chosen sound and check it against the limits. */
  decodeReplacement: (run: DecodeRun) => Promise<void>
  setSilenceThreshold: (value: number) => void
  clearReplacement: () => void
}

interface ReplacementInternals {
  /** Decode generation: bumped on each new pick, so a stale run recognises itself. */
  _decodeRun: number
}

export type ReplacementState = ReplacementSlice & ReplacementInternals

/**
 * The default matches the one the wizard used before. Moved here so the slice can be
 * reset to its initial state without looking into the component.
 */
export const DEFAULT_SILENCE_THRESHOLD_RATIO = 0.02

const EMPTY = {
  replacementAudio: null,
  replacementBuffer: null,
  replacementError: null,
  isDecodingReplacement: false,
  selectedLibraryId: null,
}

export const createReplacementSlice: StateCreator<
  ReplacementState,
  [],
  [],
  ReplacementState
> = (set, get) => ({
  ...EMPTY,
  silenceThresholdRatio: DEFAULT_SILENCE_THRESHOLD_RATIO,
  _decodeRun: 0,

  pickReplacement: (asset, libraryId = null) =>
    set((s) => ({
      replacementAudio: asset,
      replacementBuffer: null,
      replacementError: null,
      selectedLibraryId: libraryId,
      // The previous decode is no longer needed: by the time it finishes, the sound has changed.
      _decodeRun: s._decodeRun + 1,
    })),

  setSilenceThreshold: (value) => set({ silenceThresholdRatio: value }),

  clearReplacement: () =>
    set((s) => ({ ...EMPTY, _decodeRun: s._decodeRun + 1 })),

  decodeReplacement: async (run) => {
    const runId = get()._decodeRun
    const stale = () => get()._decodeRun !== runId
    set({ isDecodingReplacement: true, replacementError: null })

    const fail = (problem: ReplacementProblem) => {
      if (stale()) return
      set({ replacementBuffer: null, replacementError: problem, isDecodingReplacement: false })
    }

    try {
      const buffer = await run()
      if (stale()) return
      if (!buffer) {
        set({ isDecodingReplacement: false })
        return
      }

      // Check AFTER decoding, not only before: for exotic files the preliminary probe
      // doesn't always read the duration, and then the limit would be bypassed silently.
      if (!isAudioDurationAllowed(buffer.duration)) return fail('duration')
      if (!isAudioLayoutAllowed(buffer.sampleRate, buffer.numberOfChannels)) return fail('layout')

      set({ replacementBuffer: buffer, replacementError: null, isDecodingReplacement: false })
    } catch (err) {
      fail(isMediaValidationError(err) ? PROBE_PROBLEM[err.code] : 'decode')
    }
  },
})
