import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { getMediaLimitCopy, MEDIA_LIMITS } from '../model/mediaLimits'
import './AudioRecorder.css'

interface AudioRecorderProps {
  onRecorded: (blob: Blob) => void
  /** Surfaced to the parent so errors can sit under the white panel. */
  onError?: (message: string | null) => void
  variant?: 'default' | 'tile'
}

const CANDIDATE_MIME_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
]

function pickSupportedMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return CANDIDATE_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

type RecorderState = 'idle' | 'requesting' | 'recording' | 'error'

export function AudioRecorder({ onRecorded, onError, variant = 'default' }: AudioRecorderProps) {
  const { t } = useTranslation()
  const [state, setState] = useState<RecorderState>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const recording = getMediaLimitCopy().recording

  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const startTimeRef = useRef(0)
  const intervalRef = useRef<number | null>(null)
  const maxTimeoutRef = useRef<number | null>(null)

  const stopTimer = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    if (maxTimeoutRef.current !== null) {
      window.clearTimeout(maxTimeoutRef.current)
      maxTimeoutRef.current = null
    }
  }, [])

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [])

  // Release the mic and timer if the component unmounts mid-recording.
  useEffect(() => {
    return () => {
      stopTimer()
      releaseStream()
    }
  }, [stopTimer, releaseStream])

  const finishRecording = useCallback(() => {
    stopTimer()
    const recorder = mediaRecorderRef.current
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop()
    }
    setState('idle')
  }, [stopTimer])

  const startRecording = useCallback(async () => {
    onError?.(null)
    setState('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const mimeType = pickSupportedMimeType()
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
      chunksRef.current = []

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        chunksRef.current = []
        releaseStream()
        onRecorded(blob)
      }

      mediaRecorderRef.current = recorder
      recorder.start()
      startTimeRef.current = Date.now()
      setElapsedMs(0)
      const maxMs = MEDIA_LIMITS.recording.maxDurationSec * 1000
      intervalRef.current = window.setInterval(() => {
        setElapsedMs(Math.min(Date.now() - startTimeRef.current, maxMs))
      }, 200)
      maxTimeoutRef.current = window.setTimeout(() => {
        finishRecording()
      }, maxMs)
      setState('recording')
    } catch (err) {
      console.error(err)
      const message = t('recorder.micDenied')
      onError?.(message)
      setState('error')
      releaseStream()
    }
  }, [onRecorded, onError, releaseStream, finishRecording, t])

  if (state === 'recording') {
    return (
      <div className={`recorder recorder--active${variant === 'tile' ? ' recorder--tile' : ''}`}>
        <span className="recorder__indicator" aria-hidden="true" />
        <span className="recorder__time">{formatElapsed(elapsedMs)}</span>
        <button type="button" className="recorder__stop" onClick={finishRecording}>
          {recording.stopLabel}
        </button>
      </div>
    )
  }

  return (
    <div className={`recorder${variant === 'tile' ? ' recorder--tile' : ''}`}>
      <button
        type="button"
        className={`recorder__start${variant === 'tile' ? ' recorder__start--tile' : ''}`}
        onClick={startRecording}
        disabled={state === 'requesting'}
      >
        {/* Text and layout stay the same while we ask for mic access: the button used
            to collapse into a single line of text without the icon for that time, and
            the eye read it as a different button. The waiting state shows through
            `disabled`; the content is unchanged. */}
        <img className="recorder__icon" src="/icons/mic.svg" alt="" aria-hidden="true" />
        <span className="recorder__start-copy">
          <span className="recorder__start-label">{recording.startLabel}</span>
          <span className="recorder__start-hint">{recording.startHint}</span>
        </span>
      </button>
    </div>
  )
}
