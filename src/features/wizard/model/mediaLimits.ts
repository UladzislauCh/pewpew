/**
 * Upload / record limits for the wizard (and the how-it-works page).
 * Numeric caps live in `mediaKind.ts`; this module adds i18n error copy.
 */

import i18n from '../../../shared/i18n'
import {
  assertAudioDuration,
  assertAudioLayout,
  assertVideoDisplaySize,
  assertVideoDuration,
  isAllowedAudioDeclaration,
  isAllowedVideoDeclaration,
  isAudioSniffCompatible,
  isMediaValidationError,
  isVideoSniffCompatible,
  MEDIA_LIMITS,
  MediaValidationError,
  sniffMediaBytes,
  type MediaLimits,
  type MediaSniff,
} from '../../../domain/video/mediaKind'

// Reason codes and the checks themselves live in `mediaKind.ts` (a pure module that also runs in Node).
// Only the i18n wrapper is here: building text for the interface language.
export {
  assertAudioDuration,
  assertAudioLayout,
  assertVideoDisplaySize,
  assertVideoDuration,
  isAllowedAudioDeclaration,
  isAllowedVideoDeclaration,
  isMediaValidationError,
  MEDIA_LIMITS,
  MediaValidationError,
  sniffMediaBytes,
}
export type { MediaLimits, MediaSniff }

/** e.g. 15 → "15 MB" / "15 МБ" */
export function formatLimitMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  const value = Number.isInteger(mb) ? String(mb) : mb.toFixed(1)
  return i18n.t('limits.units.mb', { value })
}

/** e.g. 60 → "1 min" / "1 мин", 5 → "5 sec" / "5 сек" */
export function formatLimitDuration(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    return i18n.t('limits.units.min', { value: seconds / 60 })
  }
  return i18n.t('limits.units.sec', { value: seconds })
}

/** Labels / hints derived from {@link MEDIA_LIMITS} — language follows active i18n. */
export function getMediaLimitCopy() {
  const videoSize = formatLimitMegabytes(MEDIA_LIMITS.video.maxBytes)
  const videoDuration = formatLimitDuration(MEDIA_LIMITS.video.maxDurationSec)
  const audioSize = formatLimitMegabytes(MEDIA_LIMITS.audio.maxBytes)
  const audioDuration = formatLimitDuration(MEDIA_LIMITS.audio.maxDurationSec)
  const recordingDuration = formatLimitDuration(MEDIA_LIMITS.recording.maxDurationSec)

  return {
    video: {
      formats: MEDIA_LIMITS.video.formatsLabel,
      size: videoSize,
      duration: videoDuration,
      typeError: i18n.t('limits.video.typeError', { formats: MEDIA_LIMITS.video.formatsLabel }),
      sizeError: i18n.t('limits.video.sizeError', { size: videoSize }),
      durationError: i18n.t('limits.video.durationError', { duration: videoDuration }),
      tooHeavyError: i18n.t('limits.video.tooHeavyError'),
    },
    audio: {
      formats: MEDIA_LIMITS.audio.formatsLabel,
      size: audioSize,
      duration: audioDuration,
      uploadLabel: i18n.t('audioUpload.label'),
      uploadFormats: i18n.t('audioUpload.formats', {
        formats: MEDIA_LIMITS.audio.formatsLabel,
        size: audioSize,
        duration: audioDuration,
      }),
      typeError: i18n.t('limits.audio.typeError', { formats: MEDIA_LIMITS.audio.formatsLabel }),
      sizeError: i18n.t('limits.audio.sizeError', { size: audioSize }),
      durationError: i18n.t('limits.audio.durationError', { duration: audioDuration }),
      tooHeavyError: i18n.t('limits.audio.tooHeavyError'),
    },
    recording: {
      duration: recordingDuration,
      startLabel: i18n.t('recorder.start'),
      startHint: i18n.t('recorder.hint', { duration: recordingDuration }),
      requestingLabel: i18n.t('recorder.requesting'),
      stopLabel: i18n.t('recorder.stop'),
    },
  }
}

/** @deprecated Prefer {@link getMediaLimitCopy} so strings follow the active language. */
export const MEDIA_LIMIT_COPY = {
  get video() {
    return getMediaLimitCopy().video
  },
  get audio() {
    return getMediaLimitCopy().audio
  },
  get recording() {
    return getMediaLimitCopy().recording
  },
}

export function isVideoFile(file: File): boolean {
  return isAllowedVideoDeclaration(file)
}

async function readFileHead(file: Blob, byteCount = 32): Promise<Uint8Array> {
  const buf = await file.slice(0, byteCount).arrayBuffer()
  return new Uint8Array(buf)
}

/** Size / type / sniff checks before demux. Returns an error message or null. */
/**
 * What's wrong with the file — as a CODE, not as text.
 *
 * The component picks the text: translations drag in i18n and `document`, while the
 * rejection reason travels through the store, which must run in Node with its tests.
 * Same boundary as for `ProjectProblem` and the replacement sound.
 */
export type VideoFileProblem = 'type' | 'size'

export async function checkVideoFile(file: File): Promise<VideoFileProblem | null> {
  if (!isAllowedVideoDeclaration(file)) return 'type'
  if (file.size > MEDIA_LIMITS.video.maxBytes) return 'size'

  // Extension and MIME are declared by the sender, but the first bytes don't lie: a renamed
  // archive passes the declaration, not the sniff.
  const sniff = sniffMediaBytes(await readFileHead(file))
  if (!isVideoSniffCompatible(sniff)) return 'type'
  return null
}

export async function validateVideoFile(file: File): Promise<string | null> {
  const problem = await checkVideoFile(file)
  if (!problem) return null
  const copy = getMediaLimitCopy().video
  return problem === 'size' ? copy.sizeError : copy.typeError
}

/** Size / type / sniff checks before demux. Returns an error message or null. */
export async function validateAudioFile(file: File): Promise<string | null> {
  const copy = getMediaLimitCopy().audio
  if (!isAllowedAudioDeclaration(file)) return copy.typeError
  if (file.size > MEDIA_LIMITS.audio.maxBytes) return copy.sizeError

  const sniff = sniffMediaBytes(await readFileHead(file))
  if (!isAudioSniffCompatible(sniff)) return copy.typeError
  return null
}
