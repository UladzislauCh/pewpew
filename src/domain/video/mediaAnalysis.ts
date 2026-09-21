import { AudioBufferSink, BlobSource, Input, MP3, MP4, OGG, WAVE, WEBM } from 'mediabunny'
import type { InputAudioTrack, InputFormat } from 'mediabunny'
import {
  assertAudioLayout,
  assertVideoDisplaySize,
  assertVideoDuration,
  MediaValidationError,
} from './mediaKind'

/** Containers we accept for highlight uploads (MOV is ISOBMFF → MP4 demuxer). */
const VIDEO_INPUT_FORMATS: InputFormat[] = [MP4, WEBM]

/** Containers we accept for replacement-sound uploads. MP4 covers m4a. */
const AUDIO_INPUT_FORMATS: InputFormat[] = [WAVE, MP3, OGG, MP4]

// Shapes are moved out to `mediaTypes.ts`: this module depends on the browser, and
// anything importing it just for one type would drag `document` along with it.
export type { AudioTrackInfo, MediaAnalysis, VideoTrackInfo } from './mediaTypes'
import type { AudioTrackInfo, MediaAnalysis, VideoTrackInfo } from './mediaTypes'

async function decodeFullAudioBuffer(
  track: InputAudioTrack,
  audioContext: AudioContext,
): Promise<AudioBuffer> {
  const sink = new AudioBufferSink(track)
  const startTimestamp = await track.getFirstTimestamp()
  const endTimestamp = startTimestamp + (await track.computeDuration())

  const chunks: AudioBuffer[] = []
  for await (const { buffer } of sink.buffers(startTimestamp, endTimestamp)) {
    chunks.push(buffer)
  }
  if (chunks.length === 0) {
    throw new MediaValidationError('noAudioTrack')
  }

  const sampleRate = chunks[0].sampleRate
  const numberOfChannels = chunks[0].numberOfChannels
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)

  const result = audioContext.createBuffer(numberOfChannels, totalLength, sampleRate)
  let offset = 0
  for (const chunk of chunks) {
    for (let channel = 0; channel < numberOfChannels; channel++) {
      result.copyToChannel(chunk.getChannelData(channel), channel, offset)
    }
    offset += chunk.length
  }

  return result
}

/**
 * Probe container metadata, enforce duration / layout caps, then decode PCM.
 * Heavy decode runs only after the cheap checks pass.
 */
export async function analyzeMedia(file: File, audioContext: AudioContext): Promise<MediaAnalysis> {
  const input = new Input({ formats: VIDEO_INPUT_FORMATS, source: new BlobSource(file) })

  try {
    const duration = await input.computeDuration()
    assertVideoDuration(duration)

    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ])

    let video: VideoTrackInfo | null = null
    if (videoTrack) {
      const width = await videoTrack.getDisplayWidth()
      const height = await videoTrack.getDisplayHeight()
      assertVideoDisplaySize(width, height)

      const stats = await videoTrack.computePacketStats(100)
      video = {
        codec: await videoTrack.getCodec(),
        width,
        height,
        frameRate: stats.averagePacketRate || null,
      }
    }

    let audio: AudioTrackInfo | null = null
    let audioBuffer: AudioBuffer | null = null
    if (audioTrack) {
      const sampleRate = await audioTrack.getSampleRate()
      const numberOfChannels = await audioTrack.getNumberOfChannels()
      assertAudioLayout(sampleRate, numberOfChannels)

      const canDecode = await audioTrack.canDecode()
      audio = {
        codec: await audioTrack.getCodec(),
        sampleRate,
        numberOfChannels,
        duration: await audioTrack.computeDuration(),
        canDecode,
      }

      // Full PCM only after duration + layout caps passed.
      if (canDecode) {
        audioBuffer = await decodeFullAudioBuffer(audioTrack, audioContext)
      }
    }

    return { duration, video, audio, audioBuffer }
  } finally {
    input.dispose()
  }
}

/**
 * Light probe of a replacement-audio file: duration + channel layout, without decoding PCM.
 * Falls back silently (returns nulls) when the container isn't recognised — caller may still
 * try `decodeAudioData` and apply the same caps on the resulting buffer.
 */
export async function probeAudioFile(file: Blob): Promise<{
  duration: number | null
  sampleRate: number | null
  numberOfChannels: number | null
}> {
  const input = new Input({ formats: AUDIO_INPUT_FORMATS, source: new BlobSource(file) })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) return { duration: null, sampleRate: null, numberOfChannels: null }

    const [duration, sampleRate, numberOfChannels] = await Promise.all([
      track.computeDuration(),
      track.getSampleRate(),
      track.getNumberOfChannels(),
    ])
    return { duration, sampleRate, numberOfChannels }
  } catch {
    return { duration: null, sampleRate: null, numberOfChannels: null }
  } finally {
    input.dispose()
  }
}

export { MediaValidationError }
