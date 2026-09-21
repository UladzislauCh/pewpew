/**
 * Branded export: splice audio + append a 1.5s black end-card with the chicken mark,
 * the site address and SFX.
 *
 * Pipeline (mediabunny / WebCodecs throughout — the project ships no other media runtime):
 *   1) Decode source frames → encode with a single VideoEncoder (HW when available)
 *   2) Append ~1.5s of canvas frames (black + chicken + «pewpew.baby» underneath)
 *   3) Mux extended AudioBuffer (meme audio + outro sting)
 */

import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  VideoSample,
  VideoSampleSink,
  VideoSampleSource,
} from 'mediabunny'
import type { AudioCodec, VideoCodec } from 'mediabunny'
import i18n from '../../../shared/i18n'
import { getAudioContext } from '../../../domain/audio/audioContext'
import { extendChannelsWithOutro, OUTRO_DURATION_SEC } from '../../../domain/audio/outroAudio'
import { matchChannelCount, resampleLinear } from '../../../shared/lib/resample'

export { OUTRO_DURATION_SEC }

/**
 * Outro logo: webp is six times lighter than the same png (46 KB vs 279 KB), the png
 * fallback is kept for browsers without webp. The file itself is squeezed to 480px
 * wide — exactly what it's drawn at, see `paintOutroCard`.
 */
const OUTRO_LOGO_URLS = ['/pewpew-logo.webp', '/pewpew-logo.png']

/**
 * What share of the logo image's height is the chicken. Below it, in the same file, the
 * «pewpew» wordmark is drawn, and that part doesn't go into the outro: the full site
 * address is written instead.
 *
 * A share, not pixels: the image is 670px tall, the chicken ends at row 563, then an
 * empty strip and the wordmark. If the file gets recompressed to a different size, the
 * boundary moves along with it.
 */
const OUTRO_MARK_HEIGHT_SHARE = 563 / 670

/**
 * The address under the chicken. As text, not part of the image: that way it's always
 * sharp at any video resolution, and changing it is a one-line edit.
 */
const OUTRO_SITE_ADDRESS = 'pewpew.baby'
/** The site wordmark's font — same one used in the header logo text. */
const OUTRO_FONT_FAMILY = "Rajdhani, 'IBM Plex Sans', system-ui, sans-serif"
const OUTRO_FONT_WEIGHT = 700
/** Brand orange: same color the drawn wordmark used to have. */
const OUTRO_TEXT_COLOR = '#f97316'
const OUTRO_SFX_URL = '/outro/rubber-chicken.wav'

const PREFERRED_AUDIO_CODECS: AudioCodec[] = ['aac', 'opus', 'flac', 'mp3']
const PREFERRED_VIDEO_CODECS: VideoCodec[] = ['avc', 'hevc', 'vp9', 'av1']

let cachedLogoBitmap: Promise<ImageBitmap> | null = null
let cachedSfxBuffer: Promise<AudioBuffer> | null = null
let cachedOutroFont: Promise<void> | null = null

export interface ExportOutroVideoInfo {
  width: number
  height: number
  frameRate: number | null
}

function evenDimension(value: number): number {
  const rounded = Math.max(2, Math.round(value))
  return rounded % 2 === 0 ? rounded : rounded + 1
}

function normalizeFrameRate(frameRate: number | null | undefined): number {
  if (!frameRate || !Number.isFinite(frameRate) || frameRate < 1 || frameRate > 120) return 30
  return Math.round(frameRate * 1000) / 1000
}

/**
 * The wordmark's font must be loaded BEFORE drawing: unlike a page, a canvas doesn't wait
 * for a font, it silently draws with the fallback. Rajdhani is usually already on the page
 * — it sets the header logo text — but that can't be guaranteed, so we request it explicitly.
 * If it fails to load, that's fine: the text comes out in the fallback font, the video
 * doesn't break.
 */
function loadOutroFont(): Promise<void> {
  if (!cachedOutroFont) {
    cachedOutroFont = document.fonts
      .load(`${OUTRO_FONT_WEIGHT} 64px Rajdhani`)
      .then(() => undefined)
      .catch(() => {
        cachedOutroFont = null
      })
  }
  return cachedOutroFont
}

async function fetchOutroLogoBitmap(): Promise<ImageBitmap> {
  if (!cachedLogoBitmap) {
    cachedLogoBitmap = (async () => {
      let last: unknown = null
      for (const url of OUTRO_LOGO_URLS) {
        try {
          const response = await fetch(url)
          if (!response.ok) {
            throw new Error(i18n.t('wizard.errors.outroLogoFailed', { status: response.status }))
          }
          return await createImageBitmap(await response.blob())
        } catch (err) {
          last = err
        }
      }
      throw last instanceof Error ? last : new Error(String(last))
    })().catch((err) => {
      cachedLogoBitmap = null
      throw err
    })
  }
  return cachedLogoBitmap
}

async function fetchOutroSfxBuffer(): Promise<AudioBuffer> {
  if (!cachedSfxBuffer) {
    cachedSfxBuffer = fetch(OUTRO_SFX_URL)
      .then(async (response) => {
        if (!response.ok) throw new Error(i18n.t('wizard.errors.outroAudioFailed', { status: response.status }))
        const bytes = await response.arrayBuffer()
        return getAudioContext().decodeAudioData(bytes.slice(0))
      })
      .catch((err) => {
        cachedSfxBuffer = null
        throw err
      })
  }
  return cachedSfxBuffer
}

async function pickAudioCodec(
  sampleRate: number,
  numberOfChannels: number,
): Promise<AudioCodec | null> {
  for (const codec of PREFERRED_AUDIO_CODECS) {
    if (await canEncodeAudio(codec, { sampleRate, numberOfChannels })) return codec
  }
  return null
}

function audioBufferFromChannels(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const result = new AudioBuffer({
    numberOfChannels: channels.length,
    length: channels[0]?.length ?? 0,
    sampleRate,
  })
  for (let ch = 0; ch < channels.length; ch++) {
    result.copyToChannel(channels[ch] as Float32Array<ArrayBuffer>, ch)
  }
  return result
}

function channelsFromAudioBuffer(buffer: AudioBuffer): Float32Array[] {
  return Array.from({ length: buffer.numberOfChannels }, (_, ch) => buffer.getChannelData(ch))
}

function resampleAudioBuffer(buffer: AudioBuffer, targetSampleRate: number): AudioBuffer {
  if (buffer.sampleRate === targetSampleRate) return buffer
  const channels = channelsFromAudioBuffer(buffer).map((ch) =>
    resampleLinear(ch, buffer.sampleRate, targetSampleRate),
  )
  return audioBufferFromChannels(channels, targetSampleRate)
}

function matchChannels(buffer: AudioBuffer, targetChannelCount: number): AudioBuffer {
  if (buffer.numberOfChannels === targetChannelCount) return buffer
  return audioBufferFromChannels(
    matchChannelCount(channelsFromAudioBuffer(buffer), targetChannelCount),
    buffer.sampleRate,
  )
}

/** Appends `outroSec` of silence after `base`, mixing `sfx` at the start of that window. */
export function extendAudioWithOutro(
  base: AudioBuffer,
  sfx: AudioBuffer | null,
  outroSec: number,
): AudioBuffer {
  const extended = extendChannelsWithOutro(
    channelsFromAudioBuffer(base),
    base.sampleRate,
    sfx ? channelsFromAudioBuffer(sfx) : null,
    sfx?.sampleRate ?? null,
    outroSec,
  )
  return audioBufferFromChannels(extended, base.sampleRate)
}

function paintOutroCard(
  width: number,
  height: number,
  logo: ImageBitmap,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error(i18n.t('wizard.errors.outroCanvasFailed'))

  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, width, height)

  const logoWidth = evenDimension(
    Math.min(480, Math.max(72, Math.round(Math.min(width, height) * 0.32))),
  )

  // Only the chicken is taken from the image — without the «pewpew» wordmark drawn below it.
  const markSourceHeight = Math.round(logo.height * OUTRO_MARK_HEIGHT_SHARE)
  const markHeight = Math.max(2, Math.round((markSourceHeight / logo.width) * logoWidth))

  // Font size is fitted by width: the address is a bit wider than the chicken, but it
  // still fits the frame even on a narrow vertical video.
  const probeSize = 100
  const letterSpacingShare = 0.04
  ctx.font = `${OUTRO_FONT_WEIGHT} ${probeSize}px ${OUTRO_FONT_FAMILY}`
  ctx.letterSpacing = `${probeSize * letterSpacingShare}px`
  const probeWidth = Math.max(1, ctx.measureText(OUTRO_SITE_ADDRESS).width)
  const targetWidth = Math.min(logoWidth * 1.15, width * 0.86)
  const fontSize = Math.max(12, Math.floor((probeSize * targetWidth) / probeWidth))
  ctx.font = `${OUTRO_FONT_WEIGHT} ${fontSize}px ${OUTRO_FONT_FAMILY}`
  ctx.letterSpacing = `${fontSize * letterSpacingShare}px`
  const metrics = ctx.measureText(OUTRO_SITE_ADDRESS)
  const textAscent = Math.ceil(metrics.actualBoundingBoxAscent || fontSize * 0.72)
  const textDescent = Math.ceil(metrics.actualBoundingBoxDescent || fontSize * 0.2)

  // The chicken and the address are one group, and it's centered as a whole in the frame.
  const gap = Math.round(logoWidth * 0.08)
  const groupHeight = markHeight + gap + textAscent + textDescent
  const top = Math.round((height - groupHeight) / 2)

  ctx.drawImage(
    logo,
    0,
    0,
    logo.width,
    markSourceHeight,
    Math.round((width - logoWidth) / 2),
    top,
    logoWidth,
    markHeight,
  )

  ctx.fillStyle = OUTRO_TEXT_COLOR
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(OUTRO_SITE_ADDRESS, width / 2, top + markHeight + gap + textAscent)

  return canvas
}

/**
 * Progress is normalised 0..1 (main frames ≈ 0–0.85, outro ≈ 0.85–1).
 */
export async function exportVideoWithBrandedOutro(
  videoFile: File,
  audioBuffer: AudioBuffer,
  durationSec: number,
  videoInfo: ExportOutroVideoInfo,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(i18n.t('wizard.errors.invalidDuration', { duration: durationSec }))
  }

  onProgress?.(0)

  const [logo, sfx] = await Promise.all([
    fetchOutroLogoBitmap(),
    fetchOutroSfxBuffer(),
    loadOutroFont(),
  ])

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(videoFile) })

  try {
    const videoTrack = await input.getPrimaryVideoTrack()
    if (!videoTrack) {
      throw new Error(i18n.t('wizard.errors.noVideoTrack'))
    }
    if (!(await videoTrack.canDecode())) {
      throw new Error(i18n.t('wizard.errors.unsupportedCodec'))
    }

    const displayWidth = evenDimension(
      (await videoTrack.getDisplayWidth()) || videoInfo.width || 1280,
    )
    const displayHeight = evenDimension(
      (await videoTrack.getDisplayHeight()) || videoInfo.height || 720,
    )
    const frameRate = normalizeFrameRate(
      videoInfo.frameRate ?? (await videoTrack.computePacketStats(100)).averagePacketRate,
    )
    const frameDuration = 1 / frameRate

    const videoCodec = await getFirstEncodableVideoCodec(PREFERRED_VIDEO_CODECS, {
      width: displayWidth,
      height: displayHeight,
      bitrate: QUALITY_HIGH,
    })
    if (!videoCodec) {
      throw new Error(i18n.t('wizard.errors.noVideoEncoder'))
    }

    let workingAudio = extendAudioWithOutro(audioBuffer, sfx, OUTRO_DURATION_SEC)
    let audioCodec = await pickAudioCodec(workingAudio.sampleRate, workingAudio.numberOfChannels)
    if (!audioCodec) {
      workingAudio = matchChannels(resampleAudioBuffer(workingAudio, 48000), 2)
      audioCodec = await pickAudioCodec(workingAudio.sampleRate, workingAudio.numberOfChannels)
    }
    if (!audioCodec) {
      throw new Error(i18n.t('wizard.errors.noAudioEncoder'))
    }

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    })

    const videoSource = new VideoSampleSource({
      codec: videoCodec,
      bitrate: QUALITY_HIGH,
      hardwareAcceleration: 'prefer-hardware',
      keyFrameInterval: 2,
      // Bake display size so outro frames match the main clip exactly.
      transform: {
        width: displayWidth,
        height: displayHeight,
        fit: 'contain',
        force: true,
      },
    })
    output.addVideoTrack(videoSource, { frameRate })

    const audioSource = new AudioBufferSource({ codec: audioCodec, bitrate: 160_000 })
    output.addAudioTrack(audioSource)

    await output.start()

    const audioPromise = audioSource.add(workingAudio).then(() => audioSource.close())

    const sampleSink = new VideoSampleSink(videoTrack)
    let processed = 0
    const expectedMainFrames = Math.max(1, Math.round(durationSec * frameRate))

    for await (const sample of sampleSink.samples(0, durationSec)) {
      await videoSource.add(sample)
      sample.close()
      processed += 1
      onProgress?.(Math.min(0.85, (processed / expectedMainFrames) * 0.85))
    }

    const outroCanvas = paintOutroCard(displayWidth, displayHeight, logo)
    const outroFrameCount = Math.max(1, Math.round(OUTRO_DURATION_SEC * frameRate))

    for (let i = 0; i < outroFrameCount; i++) {
      const timestamp = durationSec + i * frameDuration
      const sample = new VideoSample(outroCanvas, {
        timestamp,
        duration: frameDuration,
      })
      try {
        await videoSource.add(sample, i === 0 ? { keyFrame: true } : undefined)
      } finally {
        sample.close()
      }
      onProgress?.(0.85 + ((i + 1) / outroFrameCount) * 0.14)
    }

    videoSource.close()
    await audioPromise
    await output.finalize()

    const buffer = output.target.buffer
    if (!buffer) {
      throw new Error(i18n.t('wizard.errors.muxFailed'))
    }

    onProgress?.(1)
    const mimeType = await output.getMimeType()
    return new Blob([buffer], { type: mimeType })
  } finally {
    input.dispose()
  }
}

/** Warm logo / font / SFX while the user is still on preview. */
export function prefetchExportPipeline(): void {
  void fetchOutroLogoBitmap()
  void fetchOutroSfxBuffer()
  void loadOutroFont()
}
