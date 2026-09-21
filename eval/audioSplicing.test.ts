import { describe, expect, it } from 'vitest'
import { buildSplicePlans, spliceChannels } from '../src/domain/audio/audioSplicing'
import { REPLACEMENT_LEAD_SECONDS } from '../src/domain/audio/spliceDefaults'
import type { DetectedShot } from '../src/domain/detection/shotDetection'

const SAMPLE_RATE = 48_000
const MUTE_EXTENSION_SECONDS = 0.25

function shotAt(time: number): DetectedShot {
  return { time, strength: 1, relativeLoudness: 1 }
}

/** Exponentially decaying tone — mimics a gunshot body + long reverb-like tail. */
function decayingTone(options: {
  durationSeconds: number
  shotTimeSeconds: number
  decayTauSeconds: number
  frequencyHz?: number
  peakAmplitude?: number
}): Float32Array {
  const { durationSeconds, shotTimeSeconds, decayTauSeconds } = options
  const frequencyHz = options.frequencyHz ?? 900
  const peakAmplitude = options.peakAmplitude ?? 1
  const length = Math.round(durationSeconds * SAMPLE_RATE)
  const shotSample = Math.round(shotTimeSeconds * SAMPLE_RATE)
  const data = new Float32Array(length)
  for (let i = shotSample; i < length; i++) {
    const t = (i - shotSample) / SAMPLE_RATE
    const envelope = peakAmplitude * Math.exp(-t / decayTauSeconds)
    data[i] = envelope * Math.sin(2 * Math.PI * frequencyHz * t)
  }
  return data
}

describe('buildSplicePlans', () => {
  it('extends mute past a short replacement, but only up to the extension cap', () => {
    // τ ≈ 0.18s → still clearly audible past 0.5s (like AWP reverb under a short meme clip).
    const channels = [decayingTone({ durationSeconds: 2, shotTimeSeconds: 0.5, decayTauSeconds: 0.18 })]
    const replacementLength = Math.round(0.08 * SAMPLE_RATE)
    const plans = buildSplicePlans([shotAt(0.5)], channels, SAMPLE_RATE, replacementLength, channels[0].length)

    expect(plans).toHaveLength(1)
    const { insertStartSample, insertEndSample, muteEndSample } = plans[0]
    expect(insertEndSample - insertStartSample).toBe(replacementLength)
    expect(muteEndSample).toBeGreaterThan(insertEndSample)
    // Long tails must not dig a second-long hole after a short replacement.
    expect(muteEndSample - insertEndSample).toBeLessThanOrEqual(
      Math.round(MUTE_EXTENSION_SECONDS * SAMPLE_RATE),
    )
    expect(muteEndSample - insertEndSample).toBe(Math.round(MUTE_EXTENSION_SECONDS * SAMPLE_RATE))
  })

  it('does not end the mute early on zero crossings of a still-loud tone', () => {
    // Constant-amplitude oscillating tone after the shot: every other half-cycle hits ~0, which
    // used to terminate decay search immediately when it looked at raw samples.
    const length = Math.round(2 * SAMPLE_RATE)
    const shotSample = Math.round(0.5 * SAMPLE_RATE)
    const data = new Float32Array(length)
    for (let i = shotSample; i < length; i++) {
      const t = (i - shotSample) / SAMPLE_RATE
      data[i] = Math.sin(2 * Math.PI * 1000 * t)
    }

    const replacementLength = Math.round(0.05 * SAMPLE_RATE)
    const plans = buildSplicePlans([shotAt(0.5)], [data], SAMPLE_RATE, replacementLength, length)

    expect(plans).toHaveLength(1)
    // Never drops below the decay ratio → mute hits the post-replacement extension cap.
    expect(plans[0].muteEndSample - plans[0].insertEndSample).toBe(
      Math.round(MUTE_EXTENSION_SECONDS * SAMPLE_RATE),
    )
  })

  it('still extends mute when the detected onset sits slightly before the peak', () => {
    const channels = [decayingTone({ durationSeconds: 2, shotTimeSeconds: 0.5, decayTauSeconds: 0.2 })]
    // Onset ~6ms early — common for spectral-flux detectors; peak search must recover.
    const earlyOnset = 0.5 - 0.006
    const replacementLength = Math.round(0.06 * SAMPLE_RATE)
    const plans = buildSplicePlans(
      [shotAt(earlyOnset)],
      channels,
      SAMPLE_RATE,
      replacementLength,
      channels[0].length,
    )

    expect(plans).toHaveLength(1)
    expect(plans[0].muteEndSample).toBeGreaterThan(plans[0].insertEndSample)
    expect(plans[0].muteEndSample - plans[0].insertEndSample).toBeLessThanOrEqual(
      Math.round(MUTE_EXTENSION_SECONDS * SAMPLE_RATE),
    )
  })

  it('caps the extended mute at the next shot during rapid fire', () => {
    const channels = [decayingTone({ durationSeconds: 2, shotTimeSeconds: 0.5, decayTauSeconds: 0.25 })]
    // Inject a second peak so the next-shot cap is meaningful.
    const secondShot = Math.round(0.65 * SAMPLE_RATE)
    for (let i = 0; i < Math.round(0.01 * SAMPLE_RATE); i++) {
      channels[0][secondShot + i] = Math.max(channels[0][secondShot + i], 0.9)
    }

    const replacementLength = Math.round(0.05 * SAMPLE_RATE)
    const plans = buildSplicePlans(
      [shotAt(0.5), shotAt(0.65)],
      channels,
      SAMPLE_RATE,
      replacementLength,
      channels[0].length,
    )

    expect(plans.length).toBeGreaterThanOrEqual(1)
    expect(plans[0].muteEndSample).toBeLessThanOrEqual(Math.round(0.65 * SAMPLE_RATE))
  })

  it('honours an explicit muteDurationSeconds longer than the replacement clip', () => {
    const channels = [decayingTone({ durationSeconds: 3, shotTimeSeconds: 0.5, decayTauSeconds: 0.3 })]
    const replacementLength = Math.round(0.1 * SAMPLE_RATE)
    const muteDurationSeconds = 2
    const plans = buildSplicePlans(
      [shotAt(0.5)],
      channels,
      SAMPLE_RATE,
      replacementLength,
      channels[0].length,
      { muteDurationSeconds },
    )

    expect(plans).toHaveLength(1)
    expect(plans[0].insertEndSample - plans[0].insertStartSample).toBe(replacementLength)
    expect(plans[0].muteEndSample - plans[0].insertStartSample).toBe(
      Math.round(muteDurationSeconds * SAMPLE_RATE),
    )
    expect(plans[0].duckEndSample).toBe(plans[0].muteEndSample)
  })

  it('truncates a long replacement to an explicit muteDurationSeconds shorter than the clip', () => {
    const channels = [decayingTone({ durationSeconds: 3, shotTimeSeconds: 0.5, decayTauSeconds: 0.05 })]
    const replacementLength = Math.round(3 * SAMPLE_RATE)
    const muteDurationSeconds = 0.5
    const plans = buildSplicePlans(
      [shotAt(0.5)],
      channels,
      SAMPLE_RATE,
      replacementLength,
      channels[0].length,
      { muteDurationSeconds },
    )

    expect(plans).toHaveLength(1)
    const windowSamples = plans[0].muteEndSample - plans[0].insertStartSample
    expect(windowSamples).toBe(Math.round(muteDurationSeconds * SAMPLE_RATE))
    expect(plans[0].insertEndSample).toBe(plans[0].muteEndSample)
    expect(plans[0].duckEndSample).toBe(plans[0].muteEndSample)
  })

  it('ducks original for max(0, 1.5 − clip) after a short replacement', () => {
    const channels = [decayingTone({ durationSeconds: 4, shotTimeSeconds: 0.5, decayTauSeconds: 0.1 })]
    const clipSeconds = 0.4
    const budgetSeconds = 1.5
    const replacementLength = Math.round(clipSeconds * SAMPLE_RATE)
    const plans = buildSplicePlans(
      [shotAt(0.5)],
      channels,
      SAMPLE_RATE,
      replacementLength,
      channels[0].length,
      { postDuckBudgetSeconds: budgetSeconds },
    )

    expect(plans).toHaveLength(1)
    expect(plans[0].muteEndSample).toBe(plans[0].insertEndSample)
    expect(plans[0].duckEndSample - plans[0].muteEndSample).toBe(
      Math.round((budgetSeconds - clipSeconds) * SAMPLE_RATE),
    )
  })

  it('skips the duck when the replacement is at least the budget', () => {
    const channels = [decayingTone({ durationSeconds: 4, shotTimeSeconds: 0.5, decayTauSeconds: 0.05 })]
    const replacementLength = Math.round(1.5 * SAMPLE_RATE)
    const plans = buildSplicePlans(
      [shotAt(0.5)],
      channels,
      SAMPLE_RATE,
      replacementLength,
      channels[0].length,
      { postDuckBudgetSeconds: 1.5 },
    )

    expect(plans).toHaveLength(1)
    expect(plans[0].duckEndSample).toBe(plans[0].muteEndSample)
    expect(plans[0].muteEndSample).toBe(plans[0].insertEndSample)
  })
})

describe('spliceChannels', () => {
  it('zeros the original through the extended mute window after a short replacement', () => {
    const original = [
      decayingTone({ durationSeconds: 2, shotTimeSeconds: 0.5, decayTauSeconds: 0.2, peakAmplitude: 0.8 }),
    ]
    const replacementLength = Math.round(0.07 * SAMPLE_RATE)
    const replacement = [new Float32Array(replacementLength).fill(0.5)]
    const output = spliceChannels(original, replacement, [shotAt(0.5)], SAMPLE_RATE)

    const plans = buildSplicePlans(
      [shotAt(0.5)],
      original,
      SAMPLE_RATE,
      replacementLength,
      original[0].length,
    )
    const { insertEndSample, muteEndSample } = plans[0]
    expect(muteEndSample).toBeGreaterThan(insertEndSample)

    // Midway through the post-replacement mute: original must be gone.
    const midMute = Math.floor((insertEndSample + muteEndSample) / 2)
    expect(output[0][midMute]).toBe(0)
  })

  it('applies a 0%→100% fade-in after a short replacement under postDuckBudget', () => {
    const length = Math.round(4 * SAMPLE_RATE)
    const original = [new Float32Array(length).fill(1)]
    const clipSeconds = 0.5
    const budgetSeconds = 1.5
    const replacementLength = Math.round(clipSeconds * SAMPLE_RATE)
    const replacement = [new Float32Array(replacementLength).fill(0.2)]
    const output = spliceChannels(original, replacement, [shotAt(0.5)], SAMPLE_RATE, {
      postDuckBudgetSeconds: budgetSeconds,
      fadeDurationSeconds: 0,
    })

    const insertStart = Math.round(0.5 * SAMPLE_RATE)
    const muteEnd = insertStart + replacementLength
    const duckEnd = muteEnd + Math.round((budgetSeconds - clipSeconds) * SAMPLE_RATE)
    const duckLength = duckEnd - muteEnd

    expect(output[0][muteEnd]).toBeCloseTo(0, 5)
    expect(output[0][duckEnd - 1]).toBeCloseTo(1, 5)
    const mid = muteEnd + Math.floor(duckLength / 2)
    expect(output[0][mid]).toBeGreaterThan(0)
    expect(output[0][mid]).toBeLessThan(1)
  })
})

describe('replacement lead', () => {
  it('places the sound before the moment without moving the moment itself', () => {
    // The offset lives in the splicing step, not in the label: on the timeline the
    // label must stay on the shot, otherwise it can't be checked against the waveform
    // or scored by the metric.
    const shot = shotAt(1.0)
    const lead = REPLACEMENT_LEAD_SECONDS
    const early = { ...shot, time: shot.time - lead }
    const atShot = buildSplicePlans([shot], [new Float32Array(SAMPLE_RATE * 2)], SAMPLE_RATE, 100, SAMPLE_RATE * 2)
    const shifted = buildSplicePlans([early], [new Float32Array(SAMPLE_RATE * 2)], SAMPLE_RATE, 100, SAMPLE_RATE * 2)
    expect(shot.time).toBe(1.0)
    expect(atShot[0].insertStartSample - shifted[0].insertStartSample).toBe(Math.round(lead * SAMPLE_RATE))
  })
})
