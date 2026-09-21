/**
 * Media-analysis shapes — kept SEPARATE from the analysis itself.
 *
 * WHY. `mediaAnalysis.ts` inevitably depends on the browser: it spins up an `AudioContext`
 * and pulls in i18n for a single message. Anything that imports it just for a type drags
 * `document` along with it and stops building in the Node project — which is where both
 * eval measurements and store tests live. This file holds only shapes, with zero dependencies.
 *
 * Same trick as `audioTypes.ts`: there, the readable part was pulled out of `AudioBuffer`
 * so the detection pipeline can be measured without a browser.
 */
import type { AudioLike } from '../audio/audioTypes'

export interface VideoTrackInfo {
  codec: string | null
  width: number
  height: number
  frameRate: number | null
}

export interface AudioTrackInfo {
  codec: string | null
  sampleRate: number
  numberOfChannels: number
  duration: number
  canDecode: boolean
}

export interface MediaAnalysis {
  duration: number
  video: VideoTrackInfo | null
  audio: AudioTrackInfo | null
  /**
   * The track's full decoded audio — for the waveform, detection and splicing.
   *
   * `AudioLike`, not `AudioBuffer`: a real buffer satisfies it, but only channels, sample
   * rate and duration are read from it.
   */
  audioBuffer: AudioLike | null
}
