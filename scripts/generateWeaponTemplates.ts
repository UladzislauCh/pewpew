/**
 * Offline generator: scans `weapon-samples/<weaponId>/*.wav` (raw reference recordings, never
 * committed — see .gitignore) and produces `src/domain/detection/weaponTemplates.json`, which contains only
 * derived numeric fingerprints (see `src/domain/detection/audioFingerprint.ts`), not the audio itself.
 *
 * For each weapon folder:
 *   - Every wav file is treated as one "single shot" example; their fingerprints are averaged
 *     into that weapon's `single` template (more example files = more robust template).
 *   - A "burst" template is synthesized from the loudest example by overlaying a delayed copy of
 *     itself at the weapon's approximate cyclic rate — CS2's own automatic fire is literally the
 *     same one-shot sample retriggered, so there's no separate "burst" asset to source.
 *
 * Run with: pnpm exec tsx scripts/generateWeaponTemplates.ts
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { averageFingerprints, computeShotFingerprint } from '../src/domain/detection/audioFingerprint'
import { DEFAULT_WEAPON_RPM, WEAPON_RPM, weaponLabel } from '../src/domain/detection/weapons'
import { decodeWavFile } from './wavDecode'

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const SAMPLES_DIR = join(PROJECT_ROOT, 'weapon-samples')
const OUTPUT_PATH = join(PROJECT_ROOT, 'src/domain/detection/weaponTemplates.json')

interface WeaponTemplate {
  id: string
  label: string
  sampleCount: number
  single: number[]
  burst: number[]
}

function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]
  const length = channels[0]?.length ?? 0
  const mono = new Float32Array(length)
  for (const channel of channels) {
    for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length
  }
  return mono
}

function findPeakIndex(mono: Float32Array): number {
  let peakIndex = 0
  let peakValue = 0
  for (let i = 0; i < mono.length; i++) {
    const abs = Math.abs(mono[i])
    if (abs > peakValue) {
      peakValue = abs
      peakIndex = i
    }
  }
  return peakIndex
}

/** Overlays a delayed copy of `mono` onto itself, simulating a second shot arriving `delaySamples` later. */
function synthesizeBurstWaveform(mono: Float32Array, delaySamples: number): Float32Array {
  const outLength = Math.max(mono.length, delaySamples + mono.length)
  const out = new Float32Array(outLength)
  out.set(mono, 0)
  for (let i = 0; i < mono.length; i++) {
    const targetIndex = i + delaySamples
    if (targetIndex < outLength) out[targetIndex] += mono[i]
  }
  return out
}

function processWeapon(weaponId: string): WeaponTemplate | null {
  const dir = join(SAMPLES_DIR, weaponId)
  const files = readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.wav'))
  if (files.length === 0) {
    console.warn(`  skip "${weaponId}": no .wav files found`)
    return null
  }

  const fingerprints: Float32Array[] = []
  let loudest: { mono: Float32Array; sampleRate: number; peakIndex: number; peakValue: number } | null = null

  for (const file of files) {
    const buffer = readFileSync(join(dir, file))
    let decoded
    try {
      decoded = decodeWavFile(buffer)
    } catch (err) {
      console.warn(`  skip "${weaponId}/${file}": ${(err as Error).message}`)
      continue
    }

    const mono = toMono(decoded.channels)
    const peakIndex = findPeakIndex(mono)
    const peakValue = Math.abs(mono[peakIndex])
    if (peakValue === 0) {
      console.warn(`  skip "${weaponId}/${file}": silent file`)
      continue
    }

    fingerprints.push(computeShotFingerprint(mono, decoded.sampleRate, peakIndex))
    console.log(`    ${file}: sr=${decoded.sampleRate}Hz peak@${(peakIndex / decoded.sampleRate).toFixed(3)}s`)

    if (!loudest || peakValue > loudest.peakValue) {
      loudest = { mono, sampleRate: decoded.sampleRate, peakIndex, peakValue }
    }
  }

  if (fingerprints.length === 0 || !loudest) {
    console.warn(`  skip "${weaponId}": no usable samples`)
    return null
  }

  const singleTemplate = averageFingerprints(fingerprints)

  const rpm = WEAPON_RPM[weaponId] ?? DEFAULT_WEAPON_RPM
  const delaySamples = Math.round((60 / rpm) * loudest.sampleRate)
  const burstWaveform = synthesizeBurstWaveform(loudest.mono, delaySamples)
  const burstTemplate = computeShotFingerprint(burstWaveform, loudest.sampleRate, loudest.peakIndex)

  return {
    id: weaponId,
    label: weaponLabel(weaponId),
    sampleCount: fingerprints.length,
    single: Array.from(singleTemplate),
    burst: Array.from(burstTemplate),
  }
}

function main() {
  let weaponDirs: string[]
  try {
    weaponDirs = readdirSync(SAMPLES_DIR).filter((name) => statSync(join(SAMPLES_DIR, name)).isDirectory())
  } catch {
    console.error(`"${SAMPLES_DIR}" not found — nothing to generate.`)
    process.exitCode = 1
    return
  }

  const templates: WeaponTemplate[] = []
  for (const weaponId of weaponDirs.sort()) {
    console.log(`\n${weaponId}:`)
    const template = processWeapon(weaponId)
    if (template) {
      templates.push(template)
      console.log(`  ✓ ${template.sampleCount} sample(s), rpm=${WEAPON_RPM[weaponId] ?? DEFAULT_WEAPON_RPM}`)
    }
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true })
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(templates, null, 2)}\n`)
  console.log(`\nWrote ${templates.length} weapon template(s) to ${OUTPUT_PATH}`)
}

main()
