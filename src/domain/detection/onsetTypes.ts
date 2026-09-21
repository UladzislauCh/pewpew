export interface OnsetAnalysis {
  /** Timestamp (seconds, from clip start) at the center of each analysis frame. */
  frameTimes: Float32Array
  /** Spectral flux per frame, normalized to [0, 1] by the clip's own peak. */
  spectralFlux: Float32Array
  /**
   * Frame-to-frame *increase* in high-frequency content, normalized to [0, 1].
   *
   * Deliberately a rise rather than a level: raw HFC measures how much treble is present, which stays
   * high for the whole duration of a burst of fire. Averaged into the onset curve that raised its
   * floor, and since `pickPeaks` needs the curve to fall back to a fraction of its peak before it can
   * commit another shot, a whole spray used to collapse into a single detection.
   */
  highFrequencyRise: Float32Array
  /** Combined onset strength (average of the two above), normalized to [0, 1]. */
  onsetStrength: Float32Array
  windowSize: number
  hopSize: number
  sampleRate: number
}
