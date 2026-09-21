import weaponTemplatesData from './weaponTemplates.json'
import { compareFingerprints } from './audioFingerprint'

export interface WeaponTemplate {
  id: string
  label: string
  sampleCount: number
  single: number[]
  burst: number[]
}

export interface WeaponMatch {
  weaponId: string
  label: string
  /** Cosine similarity (roughly 0..1) against the best-matching template variant. */
  confidence: number
  variant: 'single' | 'burst'
}

const templates = weaponTemplatesData as WeaponTemplate[]

export function hasWeaponTemplates(): boolean {
  return templates.length > 0
}

/**
 * Finds the closest-matching weapon template for a candidate shot fingerprint. Returns `null` if
 * no templates have been generated yet (see `npm run gen:weapon-templates`).
 *
 * Used by `shotDetection.ts` as an informational label in the UI only — not as a hard gate.
 * Matching dry game samples against in-clip audio scored worse than within-clip self-similarity
 * on the labeled examples (see `eval/README.md`), so rejection still goes through stereo width and
 * fingerprint self-similarity instead.
 */
export function matchWeaponFingerprint(fingerprint: Float32Array): WeaponMatch | null {
  let best: WeaponMatch | null = null
  for (const template of templates) {
    const singleScore = compareFingerprints(fingerprint, template.single)
    if (!best || singleScore > best.confidence) {
      best = { weaponId: template.id, label: template.label, confidence: singleScore, variant: 'single' }
    }
    const burstScore = compareFingerprints(fingerprint, template.burst)
    if (!best || burstScore > best.confidence) {
      best = { weaponId: template.id, label: template.label, confidence: burstScore, variant: 'burst' }
    }
  }
  return best
}
