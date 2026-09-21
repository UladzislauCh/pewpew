import type { AudioLike } from '../audio/audioTypes'
import type { OnsetAnalysis } from './onsetDetection'
import { detectShots, type DetectedShot, type ShotDetectionOptions } from './shotDetection'
import {
  verifyShotsWithVideo,
  type VideoVerificationOptions,
} from './videoShotVerification'

/**
 * Recall-first audio detection followed by browser-side video ownership verification (muzzle flash
 * + view recoil). Runs entirely in the client via mediabunny / WebCodecs.
 */
export async function detectShotsFused(
  file: File,
  audio: AudioLike,
  onset: OnsetAnalysis,
  audioOptions: Partial<ShotDetectionOptions> = {},
  videoOptions: Partial<VideoVerificationOptions> = {},
): Promise<DetectedShot[]> {
  const candidates = detectShots(audio, onset, audioOptions)
  return verifyShotsWithVideo(file, candidates, videoOptions)
}
