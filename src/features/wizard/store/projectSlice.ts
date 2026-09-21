/**
 * The project: the chosen clip and the analysis of its media.
 *
 * WHAT DIDN'T MOVE HERE. The analysis effect in the wizard also drove the screen overlay,
 * released the navigation lock and prefetched the next chunk. All that stayed in the wizard:
 * the store owns data, not what's on screen or where to go next. Same boundary as
 * in the replacement-sound slice.
 *
 * HOW TO ANALYSE is supplied by the caller. `analyzeMedia` pulls in mediabunny and
 * `AudioContext`, which Node doesn't have, and the slice must run with its
 * tests. The duration check, however, lives here: it's pure.
 *
 * THE CLIP URL is also created and released here. That used to be done by an effect
 * in the component, and the URL lived exactly as long as the component did.
 */
import type { StateCreator } from 'zustand'
import {
  isMediaValidationError,
  isVideoDurationAllowed,
  type MediaValidationCode,
} from '../../../domain/video/mediaKind'
import type { MediaAnalysis } from '../../../domain/video/mediaTypes'

/** How to analyse the clip. Returns `null` if analysis was cancelled. */
export type AnalyzeRun = () => Promise<MediaAnalysis | null>

/**
 * Why the clip was rejected. As in the sound slice, a CODE is stored and the component picks
 * the text: translations drag in i18n and `document`.
 *
 * `type` — not a video, or a renamed file; `size` — heavier than allowed;
 * `duration` — longer than allowed; `tooLarge` — resolution too high;
 * `audioTooHeavy` — the clip audio's sample rate or channel count is above the limit;
 * `noAudio` — no audio track, or it didn't decode;
 * `analysis` — the container couldn't be parsed, reason unknown.
 *
 * The first two arrive BEFORE the clip becomes a project: the drop zone finds them before
 * passing the file on. They still live here — there's one rejection reason per screen,
 * and keeping it in two places would mean deciding which of the two wins.
 */
export type ProjectProblem =
  | 'type'
  | 'size'
  | 'duration'
  | 'tooLarge'
  | 'audioTooHeavy'
  | 'noAudio'
  | 'analysis'

/**
 * Demux rejection code → project rejection reason.
 *
 * An EXHAUSTIVE table, not a `Partial` with a fallback: a new code in the domain must break
 * the build here so that someone decides what to show the person. That's exactly how
 * “resolution too high” got lost — any exception from analysis used to collapse into a
 * generic “couldn't process”, and three different reasons read the same.
 */
const DEMUX_PROBLEM: Record<MediaValidationCode, ProjectProblem> = {
  videoDuration: 'duration',
  videoDisplaySize: 'tooLarge',
  audioLayout: 'audioTooHeavy',
  noAudioTrack: 'noAudio',
  // Clip analysis never throws this code: audio duration is checked only for the replacement
  // sound. If it does show up, the reason isn't about the clip, and we mustn't lie about it.
  audioDuration: 'analysis',
}

export interface ProjectSlice {
  /** The chosen clip. `null` — the project is empty. */
  videoFile: File | null
  /** Clip URL for the player. Created and released right here. */
  videoUrl: string | null
  /** Container analysis: tracks, duration, decoded audio. */
  mediaAnalysis: MediaAnalysis | null
  /** Rejection reason code, not text. */
  analysisProblem: ProjectProblem | null
  isAnalyzing: boolean

  /** Pick a clip. The previous analysis and URL are cleared immediately. */
  setVideoFile: (file: File | null) => void
  /** File rejected at the door: show the reason, leave the project alone. */
  rejectVideo: (problem: ProjectProblem) => void
  /** Analyse the chosen clip. */
  analyzeProject: (run: AnalyzeRun) => Promise<void>
  clearProject: () => void
}

interface ProjectInternals {
  /** Analysis generation: bumped on each new pick, so a stale run recognises itself. */
  _analyzeRun: number
}

export type ProjectState = ProjectSlice & ProjectInternals

export const createProjectSlice: StateCreator<ProjectState, [], [], ProjectState> = (
  set,
  get,
) => {
  /** Hand the old URL back to the browser: otherwise a session accumulates one per clip. */
  const dropUrl = () => {
    const { videoUrl } = get()
    if (videoUrl) URL.revokeObjectURL(videoUrl)
  }

  return {
    videoFile: null,
    videoUrl: null,
    mediaAnalysis: null,
    analysisProblem: null,
    isAnalyzing: false,
    _analyzeRun: 0,

    setVideoFile: (file) => {
      dropUrl()
      set((s) => ({
        videoFile: file,
        videoUrl: file ? URL.createObjectURL(file) : null,
        mediaAnalysis: null,
        analysisProblem: null,
        _analyzeRun: s._analyzeRun + 1,
      }))
    },

    rejectVideo: (problem) => set({ analysisProblem: problem }),

    clearProject: () => {
      dropUrl()
      set((s) => ({
        videoFile: null,
        videoUrl: null,
        mediaAnalysis: null,
        analysisProblem: null,
        isAnalyzing: false,
        _analyzeRun: s._analyzeRun + 1,
      }))
    },

    analyzeProject: async (run) => {
      const runId = get()._analyzeRun
      const stale = () => get()._analyzeRun !== runId
      set({ isAnalyzing: true, analysisProblem: null, mediaAnalysis: null })

      try {
        const result = await run()
        if (stale()) return
        if (!result) {
          set({ isAnalyzing: false })
          return
        }
        // Duration is also checked inside analysis, before audio decoding. This is a cheap
        // safety net in case a file gets there bypassing that check.
        if (!isVideoDurationAllowed(result.duration)) {
          set({ analysisProblem: 'duration', isAnalyzing: false })
          return
        }
        /*
         * NO AUDIO, NO PROJECT — and this is the place to say so.
         *
         * Analysis doesn't reject such a clip: when there is NO audio track at all, there's
         * nothing to check, no exception is thrown, and a successful result arrives here
         * with an empty `audioBuffer`. The `noAudioTrack` code only catches the rarer case —
         * a track exists but decodes to nothing.
         *
         * How it used to end: shot detection silently skipped such a clip, readiness for the
         * file was never marked, and the waiting screen hung at ninety-seven percent
         * without a word. Rejecting here turns an endless wait into a clear reason.
         *
         * And there really is nothing to go on: the curve is built from the audio, the meme
         * goes into the audio, and the audio goes into the output file.
         */
        if (!result.audioBuffer) {
          set({ analysisProblem: 'noAudio', isAnalyzing: false })
          return
        }
        set({ mediaAnalysis: result, isAnalyzing: false })
      } catch (err) {
        if (stale()) return
        // Analysis knows exactly what's wrong and says so with a code. The code used to be
        // thrown away along with the exception, and someone with a 4K clip read about an
        // analysis failure instead of “resolution too high”.
        const problem = isMediaValidationError(err) ? DEMUX_PROBLEM[err.code] : 'analysis'
        set({ analysisProblem: problem, isAnalyzing: false })
      }
    },
  }
}
