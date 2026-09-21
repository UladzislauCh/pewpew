import { useEffect } from 'react'
import type { RefObject } from 'react'
import { getAudioContext } from '../../../domain/audio/audioContext'

/**
 * Mutes the video element and plays `audioBuffer` in sync with its timeline.
 * Re-starts on play/seek and whenever the buffer changes (e.g. trim slider).
 * Follows `video.playbackRate` so slow-motion preview stays in sync.
 */
export function useVideoReplacementAudio(
  videoRef: RefObject<HTMLVideoElement | null>,
  audioBuffer: AudioBuffer | null,
  enabled: boolean,
) {
  useEffect(() => {
    const video = videoRef.current
    if (!video || !audioBuffer || !enabled) return

    const ctx = getAudioContext()
    let source: AudioBufferSourceNode | null = null
    const previousMuted = video.muted
    video.muted = true

    const stopSource = () => {
      if (!source) return
      try {
        source.stop()
      } catch {
        // already stopped
      }
      source.disconnect()
      source = null
    }

    const startFromVideo = async () => {
      stopSource()
      if (video.paused) return

      if (ctx.state === 'suspended') {
        try {
          await ctx.resume()
        } catch {
          return
        }
      }

      const offset = Math.min(Math.max(0, video.currentTime), audioBuffer.duration)
      if (offset >= audioBuffer.duration - 1e-4) return

      const next = ctx.createBufferSource()
      next.buffer = audioBuffer
      next.playbackRate.value = video.playbackRate || 1
      next.connect(ctx.destination)
      next.start(0, offset)
      source = next
    }

    const onPlay = () => {
      void startFromVideo()
    }
    const onPauseOrEnd = () => {
      stopSource()
    }
    const onSeek = () => {
      if (!video.paused) void startFromVideo()
    }
    const onRateChange = () => {
      if (source) {
        source.playbackRate.value = video.playbackRate || 1
      } else if (!video.paused) {
        void startFromVideo()
      }
    }

    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPauseOrEnd)
    video.addEventListener('ended', onPauseOrEnd)
    video.addEventListener('seeking', onSeek)
    video.addEventListener('seeked', onSeek)
    video.addEventListener('ratechange', onRateChange)

    if (!video.paused) void startFromVideo()

    return () => {
      stopSource()
      video.muted = previousMuted
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPauseOrEnd)
      video.removeEventListener('ended', onPauseOrEnd)
      video.removeEventListener('seeking', onSeek)
      video.removeEventListener('seeked', onSeek)
      video.removeEventListener('ratechange', onRateChange)
    }
  }, [videoRef, audioBuffer, enabled])
}
