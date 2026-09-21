/**
 * Ground-truth annotation format for the detection evaluation harness.
 *
 * Label files live in `labels/<slug>.json` and are committed: they contain nothing but timestamps
 * and tags, so no copyrighted game audio ends up in the repository. The clips they describe stay
 * local in `examples/` (gitignored), as does the decoded PCM cache the harness reads.
 */

/** Who fired: the clip's own player (loud, centered) or somebody else (quieter, panned, distant). */
export type ShotSource = 'own' | 'enemy'

export interface LabeledShot {
  /** Timestamp (seconds from clip start) of the shot's transient, as placed by a human. */
  time: number
  source: ShotSource
  /** Weapon id from `WEAPON_LABELS`, or null when it isn't identifiable by ear. */
  weapon: string | null
  /**
   * Marks a shot that is buried in competing sound — music, crowd noise, an explosion, overlapping
   * fire. These are the cases the detector is expected to struggle with, and reporting them
   * separately keeps an overall score from hiding a regression on exactly the hard part.
   */
  hard: boolean
  note?: string
}

export interface ClipLabels {
  version: 1
  /** Original file name inside `examples/`, kept for human readability. */
  clip: string
  slug: string
  duration: number
  sampleRate: number
  numberOfChannels: number
  /** ISO timestamp of the last save. */
  labeledAt: string
  /** Free-form description of the clip's noise conditions. */
  notes?: string
  /** True once a human has reviewed the whole clip; unfinished drafts are excluded from scoring. */
  complete: boolean
  shots: LabeledShot[]
}

/** Deterministic 32-bit FNV-1a, so browser and Node derive identical slugs from the same name. */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * Derives a stable, filesystem-safe id from a clip's file name. Example clip names contain emoji,
 * Cyrillic and punctuation, all of which collapse away — so a short hash of the full original name
 * is appended to keep distinct clips from colliding on the same readable prefix.
 */
export function slugifyClipName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, '')
  const readable = base
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/, '')
  return `${readable || 'clip'}-${fnv1a32(fileName)}`
}

export function sortShotsByTime<T extends { time: number }>(shots: readonly T[]): T[] {
  return [...shots].sort((a, b) => a.time - b.time)
}

/**
 * Validates a parsed JSON label file, throwing on anything malformed. The harness refuses to score
 * against labels it doesn't fully understand rather than silently treating them as "no shots".
 */
export function parseClipLabels(raw: unknown, context: string): ClipLabels {
  const fail = (reason: string): never => {
    throw new Error(`Invalid labels in ${context}: ${reason}`)
  }
  if (typeof raw !== 'object' || raw === null) return fail('not an object')

  const data = raw as Record<string, unknown>
  if (data.version !== 1) return fail(`unsupported version ${String(data.version)}`)
  if (typeof data.slug !== 'string') return fail('missing slug')
  if (!Array.isArray(data.shots)) return fail('missing shots array')

  const shots: LabeledShot[] = data.shots.map((entry, index) => {
    const shot = entry as Record<string, unknown>
    if (typeof shot?.time !== 'number' || !Number.isFinite(shot.time)) {
      return fail(`shot ${index} has a non-numeric time`)
    }
    if (shot.source !== 'own' && shot.source !== 'enemy') {
      return fail(`shot ${index} has an unknown source ${String(shot.source)}`)
    }
    return {
      time: shot.time,
      source: shot.source,
      weapon: typeof shot.weapon === 'string' ? shot.weapon : null,
      hard: shot.hard === true,
      ...(typeof shot.note === 'string' && shot.note ? { note: shot.note } : {}),
    }
  })

  return {
    version: 1,
    clip: typeof data.clip === 'string' ? data.clip : data.slug,
    slug: data.slug,
    duration: typeof data.duration === 'number' ? data.duration : 0,
    sampleRate: typeof data.sampleRate === 'number' ? data.sampleRate : 0,
    numberOfChannels: typeof data.numberOfChannels === 'number' ? data.numberOfChannels : 0,
    labeledAt: typeof data.labeledAt === 'string' ? data.labeledAt : '',
    ...(typeof data.notes === 'string' && data.notes ? { notes: data.notes } : {}),
    complete: data.complete === true,
    shots: sortShotsByTime(shots),
  }
}
