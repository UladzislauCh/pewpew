/**
 * Pure media kind / limit checks — safe in Node (eval harness) and the browser.
 * Localized error strings live in `mediaLimits.ts`.
 */

export const MEDIA_LIMITS = {
  video: {
    /** Hard cap on file size. */
    maxBytes: 15 * 1024 * 1024,
    /** Hard cap on container duration (checked before full PCM decode). */
    maxDurationSec: 60,
    /** Longest display edge (px). */
    maxLongSide: 2560,
    /** Shortest display edge (px). */
    maxShortSide: 1440,
    /** Shown in hints. */
    formatsLabel: 'mp4, webm, mov',
    /** File-picker filter — extensions + common MIME types. */
    accept: '.mp4,.webm,.mov,video/mp4,video/webm,video/quicktime',
    extensions: ['.mp4', '.webm', '.mov'] as const,
    mimeTypes: ['video/mp4', 'video/webm', 'video/quicktime'] as const,
  },
  audio: {
    maxBytes: 5 * 1024 * 1024,
    maxDurationSec: 5,
    /** Reject exotic layouts before / right after light probe. */
    maxSampleRate: 96_000,
    maxChannels: 2,
    formatsLabel: 'mp3, wav, ogg, m4a',
    accept:
      '.mp3,.wav,.ogg,.m4a,.aac,audio/mpeg,audio/wav,audio/wave,audio/x-wav,audio/ogg,audio/mp4,audio/aac,audio/x-m4a',
    extensions: ['.mp3', '.wav', '.ogg', '.m4a', '.aac'] as const,
    mimeTypes: [
      'audio/mpeg',
      'audio/mp3',
      'audio/wav',
      'audio/wave',
      'audio/x-wav',
      'audio/ogg',
      'audio/mp4',
      'audio/aac',
      'audio/x-m4a',
      'audio/m4a',
    ] as const,
  },
  recording: {
    maxDurationSec: 5,
  },
} as const

export type MediaLimits = typeof MEDIA_LIMITS

function fileExtension(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? name
  const dot = base.lastIndexOf('.')
  if (dot < 0) return ''
  return base.slice(dot).toLowerCase()
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(bytes[offset + i] ?? 0)
  }
  return out
}

/**
 * Cheap container sniff from the first bytes. Used to reject obvious
 * MIME/extension spoofing before handing the file to demuxers.
 */
export type MediaSniff =
  | 'isobmff' // mp4 / mov / m4a
  | 'webm'
  | 'wav'
  | 'ogg'
  | 'mp3'
  | 'unknown'

export function sniffMediaBytes(bytes: Uint8Array): MediaSniff {
  if (bytes.length < 12) return 'unknown'

  // EBML (WebM / Matroska)
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'webm'
  }

  // ISO BMFF — `....ftyp....`
  if (ascii(bytes, 4, 4) === 'ftyp') return 'isobmff'

  // RIFF WAVE
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'wav'

  // Ogg
  if (ascii(bytes, 0, 4) === 'OggS') return 'ogg'

  // MP3 — ID3 tag or frame sync
  if (ascii(bytes, 0, 3) === 'ID3') return 'mp3'
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'mp3'

  return 'unknown'
}

const VIDEO_SNIFFS = new Set<MediaSniff>(['isobmff', 'webm', 'unknown'])
const AUDIO_SNIFFS = new Set<MediaSniff>(['isobmff', 'wav', 'ogg', 'mp3', 'unknown'])

export function isVideoSniffCompatible(sniff: MediaSniff): boolean {
  return VIDEO_SNIFFS.has(sniff)
}

export function isAudioSniffCompatible(sniff: MediaSniff): boolean {
  return AUDIO_SNIFFS.has(sniff)
}

export function isAllowedVideoDeclaration(file: { name: string; type: string }): boolean {
  const ext = fileExtension(file.name)
  const mime = file.type.toLowerCase()
  const extOk = (MEDIA_LIMITS.video.extensions as readonly string[]).includes(ext)
  const mimeOk = mime !== '' && (MEDIA_LIMITS.video.mimeTypes as readonly string[]).includes(mime)
  // Empty MIME is common for .mov on some platforms — allow when extension matches.
  if (mime === '') return extOk
  return mimeOk || extOk
}

export function isAllowedAudioDeclaration(file: { name: string; type: string }): boolean {
  const ext = fileExtension(file.name)
  const mime = file.type.toLowerCase()
  const extOk = (MEDIA_LIMITS.audio.extensions as readonly string[]).includes(ext)
  const mimeOk = mime !== '' && (MEDIA_LIMITS.audio.mimeTypes as readonly string[]).includes(mime)
  if (mime === '') return extOk
  return mimeOk || extOk
}

export function isVideoDurationAllowed(durationSec: number): boolean {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return true
  return durationSec <= MEDIA_LIMITS.video.maxDurationSec
}

export function isVideoDisplaySizeAllowed(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
  const longSide = Math.max(width, height)
  const shortSide = Math.min(width, height)
  return longSide <= MEDIA_LIMITS.video.maxLongSide && shortSide <= MEDIA_LIMITS.video.maxShortSide
}

export function isAudioDurationAllowed(durationSec: number): boolean {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return true
  return durationSec <= MEDIA_LIMITS.audio.maxDurationSec
}

export function isAudioLayoutAllowed(sampleRate: number, numberOfChannels: number): boolean {
  return (
    Number.isFinite(sampleRate) &&
    sampleRate > 0 &&
    sampleRate <= MEDIA_LIMITS.audio.maxSampleRate &&
    Number.isFinite(numberOfChannels) &&
    numberOfChannels >= 1 &&
    numberOfChannels <= MEDIA_LIMITS.audio.maxChannels
  )
}

/**
 * The reason a demux is rejected is a CODE, not text. This module also runs in Node
 * (detection, evals), and the component picks the text for the code — the same boundary
 * as `ProjectProblem` and `ReplacementProblem` in the wizard store.
 */
export type MediaValidationCode =
  | 'videoDuration'
  | 'videoDisplaySize'
  | 'audioDuration'
  | 'audioLayout'
  | 'noAudioTrack'

/** Thrown by demux pipelines when a file fails size / duration / layout / track checks. */
export class MediaValidationError extends Error {
  override readonly name = 'MediaValidationError'
  readonly code: MediaValidationCode
  constructor(code: MediaValidationCode) {
    super(code)
    this.code = code
  }
}

export function isMediaValidationError(err: unknown): err is MediaValidationError {
  return err instanceof MediaValidationError || (err instanceof Error && err.name === 'MediaValidationError')
}

/** Assert helpers for demux pipelines — throw {@link MediaValidationError} with a code. */
export function assertVideoDuration(durationSec: number): void {
  if (!isVideoDurationAllowed(durationSec)) throw new MediaValidationError('videoDuration')
}

export function assertVideoDisplaySize(width: number, height: number): void {
  if (!isVideoDisplaySizeAllowed(width, height)) throw new MediaValidationError('videoDisplaySize')
}

export function assertAudioDuration(durationSec: number): void {
  if (!isAudioDurationAllowed(durationSec)) throw new MediaValidationError('audioDuration')
}

export function assertAudioLayout(sampleRate: number, numberOfChannels: number): void {
  if (!isAudioLayoutAllowed(sampleRate, numberOfChannels)) throw new MediaValidationError('audioLayout')
}
