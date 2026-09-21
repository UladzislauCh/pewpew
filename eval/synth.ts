/**
 * Deterministic synthetic audio for tests: gunshot-like transients placed at known timestamps on
 * top of controllable interference.
 *
 * Real clips are local and copyrighted, so they can't back a committed test suite. Synthetic
 * signals can: they run in milliseconds, need no fixtures, and let a test state the exact condition
 * it is about ("a quiet shot 30 dB below an explosion") instead of relying on whatever a recording
 * happens to contain.
 */
import type { AudioLike } from '../src/domain/audio/audioTypes'
import { audioFromChannels } from './fixtures'

/** Small, fast, seedable PRNG so every generated signal is byte-for-byte reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface ShotSpec {
  time: number
  /** Peak amplitude in [0, 1]. */
  amplitude: number
  /** Envelope decay constant in seconds; CS2-ish rifle cracks sit around 25–40 ms. */
  decaySeconds?: number
}

export interface SignalSpec {
  durationSeconds: number
  sampleRate?: number
  shots: ShotSpec[]
  /** Amplitude of stationary white noise, e.g. crowd hiss. */
  noiseAmplitude?: number
  /** Sustained tonal interference (amplitude + frequencies), standing in for background music. */
  tone?: { amplitude: number; frequencies: number[] }
  seed?: number
  /**
   * Renders two channels instead of one, with this much independence between them: 0 gives identical
   * channels (a dead-center mono mix), 1 gives fully independent ones (a maximally wide image).
   * Omitted entirely, the signal stays mono.
   */
  stereoDecorrelation?: number
}

/**
 * One broadband transient: an instant attack followed by an exponential decay, which is the part of
 * a gunshot every onset detector keys on.
 */
function addShot(target: Float32Array, sampleRate: number, shot: ShotSpec, random: () => number): void {
  const decay = shot.decaySeconds ?? 0.03
  const start = Math.round(shot.time * sampleRate)
  const length = Math.round(decay * 6 * sampleRate)

  for (let i = 0; i < length; i++) {
    const index = start + i
    if (index < 0 || index >= target.length) continue
    const envelope = Math.exp(-i / (decay * sampleRate))
    target[index] += shot.amplitude * envelope * (random() * 2 - 1)
  }
  // A single full-scale sample at the attack keeps the peak deterministic, so amplitude-relative
  // gates in the detector see exactly the ratio a test asks for.
  if (start >= 0 && start < target.length) target[start] = shot.amplitude
}

function renderChannel(spec: SignalSpec, sampleRate: number, length: number, seed: number): Float32Array {
  const random = mulberry32(seed)
  const samples = new Float32Array(length)

  const noiseAmplitude = spec.noiseAmplitude ?? 0
  if (noiseAmplitude > 0) {
    for (let i = 0; i < length; i++) samples[i] += noiseAmplitude * (random() * 2 - 1)
  }

  if (spec.tone) {
    for (const frequency of spec.tone.frequencies) {
      const phase = random() * Math.PI * 2
      for (let i = 0; i < length; i++) {
        samples[i] += spec.tone.amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate + phase)
      }
    }
  }

  for (const shot of spec.shots) addShot(samples, sampleRate, shot, random)

  return samples
}

export function synthesizeSignal(spec: SignalSpec): AudioLike {
  const sampleRate = spec.sampleRate ?? 44100
  const length = Math.round(spec.durationSeconds * sampleRate)
  const seed = spec.seed ?? 1

  const left = renderChannel(spec, sampleRate, length, seed)
  if (spec.stereoDecorrelation === undefined) return audioFromChannels([left], sampleRate)

  const independent = renderChannel(spec, sampleRate, length, seed + 9973)
  const width = spec.stereoDecorrelation
  const right = new Float32Array(length)
  for (let i = 0; i < length; i++) right[i] = (1 - width) * left[i] + width * independent[i]

  return audioFromChannels([left, right], sampleRate)
}

/** Evenly spaced shots, as an automatic weapon produces (AK-47 at 600 rpm = one per 100 ms). */
export function burst(startTime: number, count: number, intervalSeconds: number, amplitude = 0.9): ShotSpec[] {
  return Array.from({ length: count }, (_, index) => ({
    time: startTime + index * intervalSeconds,
    amplitude,
  }))
}
