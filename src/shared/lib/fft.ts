export interface FFT {
  readonly size: number
  /** In-place transform. `re`/`im` must both have length `size`. */
  transform(re: Float32Array, im: Float32Array): void
}

/**
 * Creates a reusable iterative radix-2 Cooley-Tukey FFT plan for a fixed power-of-two size.
 * Twiddle factors are precomputed once and reused across every `transform` call, which matters
 * here since we run one FFT per analysis frame (potentially thousands per clip).
 */
export function createFFT(size: number): FFT {
  if (size < 2 || (size & (size - 1)) !== 0) {
    throw new Error('FFT size must be a power of two >= 2')
  }

  const cosTable = new Float32Array(size / 2)
  const sinTable = new Float32Array(size / 2)
  for (let i = 0; i < size / 2; i++) {
    const angle = (-2 * Math.PI * i) / size
    cosTable[i] = Math.cos(angle)
    sinTable[i] = Math.sin(angle)
  }

  return {
    size,
    transform(re: Float32Array, im: Float32Array) {
      // Bit-reversal permutation.
      for (let i = 1, j = 0; i < size; i++) {
        let bit = size >> 1
        for (; j & bit; bit >>= 1) j ^= bit
        j ^= bit
        if (i < j) {
          const tmpRe = re[i]
          re[i] = re[j]
          re[j] = tmpRe
          const tmpIm = im[i]
          im[i] = im[j]
          im[j] = tmpIm
        }
      }

      // Iterative butterfly combine.
      for (let len = 2; len <= size; len <<= 1) {
        const halfLen = len >> 1
        const tableStep = size / len
        for (let i = 0; i < size; i += len) {
          for (let k = 0, t = 0; k < halfLen; k++, t += tableStep) {
            const wRe = cosTable[t]
            const wIm = sinTable[t]
            const evenIndex = i + k
            const oddIndex = i + k + halfLen
            const oddRe = re[oddIndex] * wRe - im[oddIndex] * wIm
            const oddIm = re[oddIndex] * wIm + im[oddIndex] * wRe
            re[oddIndex] = re[evenIndex] - oddRe
            im[oddIndex] = im[evenIndex] - oddIm
            re[evenIndex] += oddRe
            im[evenIndex] += oddIm
          }
        }
      }
    },
  }
}
