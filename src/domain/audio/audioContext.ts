/**
 * The app's single shared AudioContext — with an EXPLICITLY set sample rate.
 *
 * The rate here isn't a preference, it's part of the model's contract. `decodeAudioData`
 * resamples audio to the context's rate, while `new AudioContext()` without arguments takes
 * it from the sound card: 44100 on some machines, 48000 on others. Without this line, the
 * detection result would depend on the user's hardware.
 *
 * Measured: across 49 clips, at 48000 the net yields 4518 candidates, at 44100 — 4808, a 6%
 * difference. Per-clip at 44100 the numbers match the reference exactly (ak47 85 vs 85, aug 35
 * vs 35), at 48000 they diverge (82 vs 85).
 *
 * 44100 because 48 of 49 clips were labeled and the net trained at that rate. This constant
 * can only be changed together with retraining ShotNet.
 */
const ANALYSIS_SAMPLE_RATE = 44100

let sharedAudioContext: AudioContext | null = null

export function getAudioContext(): AudioContext {
  if (!sharedAudioContext) {
    try {
      sharedAudioContext = new AudioContext({ sampleRate: ANALYSIS_SAMPLE_RATE })
    } catch {
      // If the platform won't give us this rate, it's better to run with some rate than
      // not at all: fall back to the device's rate with a known-and-accepted quality loss.
      sharedAudioContext = new AudioContext()
    }
  }
  return sharedAudioContext
}
