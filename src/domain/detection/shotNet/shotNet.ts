import type { MelSpectrogram } from './melSpectrogram'

/**
 * A small one-dimensional convolutional network: from a mel spectrogram it outputs, for EACH
 * frame, a "shot here" score.
 *
 * Convolution runs over time, and mel bands act as input channels. This gives invariance to time
 * shift — what the linear model on a mel patch lacked (it came out worse than the hand-crafted
 * fingerprint precisely because of that).
 *
 * The scheme is deliberately per-frame, not "a classifier on top of candidates": peaks are found
 * on a curve that already means "a shot is here", not "energy changed here". This also removes
 * the 10:1 class imbalance and the recall ceiling of the old detector.
 */

export interface ShotNetConfig {
  /** Number of input mel bands. */
  inputBands: number
  /** Output channels of each convolutional layer. The last must be 1. */
  channels: number[]
  /** Kernel size of each layer. Odd, so the padding is symmetric. */
  kernels: number[]
  /**
   * Per-layer convolution dilation. Allows seeing long context without growing the parameter
   * count: a shot differs from a music hit primarily by its DECAY, and that lasts 300-500 ms —
   * much longer than a window of dense kernels.
   * Ones by default, i.e. ordinary convolution.
   */
  dilations?: number[]
}

export const DEFAULT_SHOTNET_CONFIG: ShotNetConfig = {
  inputBands: 40,
  channels: [24, 24, 16, 1],
  kernels: [5, 3, 3, 3],
}

export interface ShotNetWeights {
  config: ShotNetConfig
  /** Per layer: weights in [outCh][inCh][k] order. */
  w: Float32Array[]
  /** Per layer: biases of length outCh. */
  b: Float32Array[]
}

/** Layer dilations, with ones substituted by default. */
export function dilationsOf(config: ShotNetConfig): number[] {
  return config.dilations ?? config.kernels.map(() => 1)
}

/** How many frames the network sees around each output frame. */
export function receptiveField(config: ShotNetConfig): number {
  const d = dilationsOf(config)
  return config.kernels.reduce((acc, k, i) => acc + (k - 1) * d[i], 1)
}

export function countParameters(w: ShotNetWeights): number {
  return w.w.reduce((a, x) => a + x.length, 0) + w.b.reduce((a, x) => a + x.length, 0)
}

/** He initialisation — for ReLU, otherwise the signal fades from layer to layer. */
export function createWeights(config: ShotNetConfig, random: () => number): ShotNetWeights {
  const w: Float32Array[] = []
  const b: Float32Array[] = []
  let inCh = config.inputBands

  for (let l = 0; l < config.channels.length; l++) {
    const outCh = config.channels[l]
    const k = config.kernels[l]
    const fanIn = inCh * k
    const std = Math.sqrt(2 / fanIn)
    const layer = new Float32Array(outCh * inCh * k)
    for (let i = 0; i < layer.length; i++) {
      // Box-Muller: normal noise is needed, uniform gives a noticeably worse start.
      const u1 = Math.max(random(), 1e-12)
      const u2 = random()
      layer[i] = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2) * std
    }
    w.push(layer)
    b.push(new Float32Array(outCh))
    inCh = outCh
  }

  return { config, w, b }
}

export interface ForwardResult {
  /** Activations after each layer, [layer][channel * frames + frame]. The last layer is logits. */
  activations: Float32Array[]
  frames: number
}

/**
 * Forward pass over the whole recording at once.
 * "Same" zero padding, so the output length matches the frame count.
 * Used both in production and in training — so forward and backward do not drift apart.
 */
export function forward(weights: ShotNetWeights, input: Float32Array, frames: number): ForwardResult {
  const { config } = weights
  const dil_ = dilationsOf(config)
  const activations: Float32Array[] = []
  let cur = input
  let inCh = config.inputBands

  for (let l = 0; l < config.channels.length; l++) {
    const outCh = config.channels[l]
    const k = config.kernels[l]
    const halfK = (k - 1) >> 1
    const dil = dil_[l]
    const w = weights.w[l]
    const b = weights.b[l]
    const out = new Float32Array(outCh * frames)
    const isLast = l === config.channels.length - 1

    for (let oc = 0; oc < outCh; oc++) {
      const outOff = oc * frames
      const bias = b[oc]
      for (let t = 0; t < frames; t++) out[outOff + t] = bias

      for (let ic = 0; ic < inCh; ic++) {
        const inOff = ic * frames
        const wOff = (oc * inCh + ic) * k
        for (let j = 0; j < k; j++) {
          const weight = w[wOff + j]
          if (weight === 0) continue
          const shift = (j - halfK) * dil
          const tStart = Math.max(0, -shift)
          const tEnd = Math.min(frames, frames - shift)
          for (let t = tStart; t < tEnd; t++) {
            out[outOff + t] += weight * cur[inOff + t + shift]
          }
        }
      }
    }

    if (!isLast) {
      for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0
    }

    activations.push(out)
    cur = out
    inCh = outCh
  }

  return { activations, frames }
}

export const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z))

/** Per-frame shot probability. The spectrogram must already be normalised. */
export function predict(weights: ShotNetWeights, spec: MelSpectrogram): Float32Array {
  const { activations, frames } = forward(weights, spec.data, spec.frames)
  const logits = activations[activations.length - 1]
  const out = new Float32Array(frames)
  for (let t = 0; t < frames; t++) out[t] = sigmoid(logits[t])
  return out
}

/** Serialising weights to JSON — the model arrives in the browser as a plain file, no runtime. */
export function serializeWeights(weights: ShotNetWeights): string {
  return JSON.stringify({
    config: weights.config,
    w: weights.w.map((x) => Array.from(x, (v) => +v.toFixed(6))),
    b: weights.b.map((x) => Array.from(x, (v) => +v.toFixed(6))),
  })
}

export function deserializeWeights(json: string): ShotNetWeights {
  const raw = JSON.parse(json)
  return {
    config: raw.config,
    w: raw.w.map((x: number[]) => Float32Array.from(x)),
    b: raw.b.map((x: number[]) => Float32Array.from(x)),
  }
}
