import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { useWizardStore } from '../store/wizardStore'
import { MediaAnalysisPanel } from './MediaAnalysisPanel'
import { OnsetCurveView } from '../../../shared/ui/OnsetCurveView'
import type { OnsetAnalysis } from '../../../domain/detection/onsetDetection'
import type { MediaAnalysis } from '../../../domain/video/mediaAnalysis'
import './VideoShotsEditor.css'

const PLAYBACK_RATES = [0.25, 0.5, 1] as const

/**
 * Marker colour by detector confidence.
 *
 * `strength` carries the net's per-shot confidence (0..1), so weak marks can look weak. Without
 * this every mark looks equally certain and the user has no way to tell which ones the detector
 * was unsure about — they end up auditioning all of them one by one.
 */
function shotColor(strength: number): string {
  const alpha = 0.45 + 0.55 * Math.max(0, Math.min(1, strength))
  return `rgba(251, 146, 60, ${alpha.toFixed(2)})`
}

interface VideoShotsEditorProps {
  videoUrl: string
  videoRef: RefObject<HTMLVideoElement | null>
  mediaAnalysis: MediaAnalysis | null
  onsetAnalysis: OnsetAnalysis | null
  isAnalyzing: boolean
  analysisError: string | null
  /** Whether the second video pass is running: it refines markers after they've appeared. */
  isScoringMotion?: boolean
  /** Extra section under the waveform (e.g. trim controls on preview). */
  footer?: ReactNode
  /**
   * Track and video are view-only: the check screen.
   *
   * There “tools stay hidden until the answer is ‘no’”, and the screen has ONE transport —
   * its own, under the track. So the native video controls, the speed picker and all
   * track editing are removed here.
   */
  readOnly?: boolean
  /** Time the track view is brought to (stepping through markers on the edit screen). */
  focusTime?: number | null
  /** Width of the window the track zooms to on such a jump, in seconds. */
  focusZoomSeconds?: number | null
}

export function VideoShotsEditor({
  videoUrl,
  videoRef,
  mediaAnalysis,
  onsetAnalysis,
  isAnalyzing,
  analysisError,
  isScoringMotion = false,
  footer,
  readOnly = false,
  focusTime = null,
  focusZoomSeconds = null,
}: VideoShotsEditorProps) {
  const { t } = useTranslation()
  // Markers and their operations come from the store, not threaded from above: they used
  // to go through three levels — wizard, step, editor. `OnsetCurveView` below still gets
  // them as props, and that's DELIBERATE: the same component is used by the labelling
  // tool, which has its own state.
  const shots = useWizardStore((s) => s.shots)
  const onAddShot = useWizardStore((s) => s.addShot)
  const onRemoveShot = useWizardStore((s) => s.removeShot)
  const onMoveShot = useWizardStore((s) => s.moveShot)
  const onMoveShotEnd = useWizardStore((s) => s.finalizeShotOrder)
  const ready = Boolean(mediaAnalysis?.audioBuffer && onsetAnalysis)
  const [playbackRate, setPlaybackRate] = useState<number>(1)
  // The track takes raw samples, not the buffer. Via `useMemo` — otherwise every render
  // would pass a new reference and the canvas would redraw for nothing.
  const samples = useMemo(
    () => mediaAnalysis?.audioBuffer?.getChannelData(0) ?? null,
    [mediaAnalysis],
  )
  const shotColors = useMemo(
    () => shots.map((s) => shotColor(s.strength)),
    [shots],
  )

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [videoRef, playbackRate, videoUrl])

  return (
    /*
     * TWO CARDS, NOT ONE, as in the mockup: the video has its own border, the shot track
     * its own, with a gap between them. It used to be one block with a shared border,
     * with the track canvas set flush without its own border — unlike the mockup.
     */
    <div className="video-shots-editor">
      <div className="video-shots-editor__card">
        <video
          ref={videoRef}
          className="video-shots-editor__video"
          src={videoUrl}
          controls={!readOnly}
          playsInline
          onLoadedMetadata={(event) => {
            event.currentTarget.playbackRate = playbackRate
          }}
        />

        {!readOnly && (
          <div className="video-shots-editor__rates" role="group" aria-label={t('shotsEditor.rateAria')}>
            <span className="video-shots-editor__rates-label">{t('shotsEditor.rateLabel')}</span>
            {PLAYBACK_RATES.map((rate) => (
              <button
                key={rate}
                type="button"
                className={`video-shots-editor__rate${rate === playbackRate ? ' video-shots-editor__rate--active' : ''}`}
                onClick={() => setPlaybackRate(rate)}
              >
                {rate}×
              </button>
            ))}
          </div>
        )}

        <MediaAnalysisPanel isLoading={isAnalyzing} error={analysisError} />

        {isScoringMotion && (
          <div className="video-shots-editor__motion-status">{t('shotsEditor.scoringMotion')}</div>
        )}
      </div>

      {ready && mediaAnalysis?.audioBuffer && onsetAnalysis && samples && (
        <OnsetCurveView
          samples={samples}
          sampleRate={mediaAnalysis.audioBuffer.sampleRate}
          duration={mediaAnalysis.audioBuffer.duration}
          frameTimes={onsetAnalysis.frameTimes}
          onsetStrength={onsetAnalysis.onsetStrength}
          videoRef={videoRef}
          shots={shots}
          shotColors={shotColors}
          visualProfile="shots-first"
          embedded
          selectable={!readOnly}
          readOnly={readOnly}
          focusTime={focusTime}
          focusZoomSeconds={focusZoomSeconds}
          onAddShot={onAddShot}
          onRemoveShot={onRemoveShot}
          onMoveShot={onMoveShot}
          onMoveShotEnd={onMoveShotEnd}
        />
      )}

      {footer && <div className="video-shots-editor__footer">{footer}</div>}
    </div>
  )
}
