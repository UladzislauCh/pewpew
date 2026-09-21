import { useCallback, useEffect, useState } from 'react'
import type { RefObject } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { VideoShotsEditor } from '../components/VideoShotsEditor'
import { useVideoReplacementAudio } from '../model/useVideoReplacementAudio'
import type { OnsetAnalysis } from '../../../domain/detection/onsetDetection'
import type { MediaAnalysis } from '../../../domain/video/mediaAnalysis'
import { useWizardStore } from '../store/wizardStore'
import { WizardLayout } from '../WizardLayout'
import './CheckShotsStep.css'

interface CheckShotsStepProps {
  videoUrl: string
  videoRef: RefObject<HTMLVideoElement | null>
  mediaAnalysis: MediaAnalysis | null
  onsetAnalysis: OnsetAnalysis | null
  isAnalyzing: boolean
  analysisError: string | null
  /** The clip WITH the meme spliced in: the reason this screen exists. */
  splicedAudioBuffer: AudioBuffer | null
  /** Name of the meme currently in place — from the library or the person's own file. */
  soundName: string | null
  busy?: boolean
  onBack: () => void
  /** “Yes, next” — on to picking your own meme. */
  onAccept: () => void
  /** “No, fix it” — open marker editing. */
  onFix: () => void
  isScoringMotion?: boolean
  /**
   * The model ran on wasm, i.e. the GPU wasn't picked up.
   *
   * Shown as a DOT at the end of the title and nothing more: there's nothing to explain
   * to the user, but by eye we need to tell “slow device” from “device fell back to the
   * slow path” — the measured difference between them is seventeenfold.
   */
  slowBackend?: boolean
}

/** `0:09.4` — tenths are needed: otherwise you can't tell 9.4 from 9.9 in a burst by eye. */
function formatTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0
  const mins = Math.floor(safe / 60)
  const rest = safe - mins * 60
  return `${mins}:${rest.toFixed(1).padStart(4, '0')}`
}

/**
 * Check screen: shots are already replaced; the person listens and answers one question.
 *
 * WHY LISTEN, NOT LOOK. The replacement isn't layered over the shot; it mutes the
 * original around the marker. Marker in place — you hear a clean meme; marker off — the
 * mute covered silence and the real shot stayed next to it: you get “bonk-bang”. Anyone
 * can hear the error, no waveform reading required. By eye it can't be caught: on the
 * overview track a second is 32 pixels, and a 50 ms offset is one and a half.
 *
 * WHY NO STEPPING THROUGH MARKERS. Stepping only shows places where a marker EXISTS,
 * so by construction it can't show a missed shot — and every fourth or fifth shot is
 * missed. So this is skipping, not checking: the “next shot” button is for jumping over
 * the running around between bursts; the clip should be listened to in full.
 */
export function CheckShotsStep({
  videoUrl,
  videoRef,
  mediaAnalysis,
  onsetAnalysis,
  isAnalyzing,
  analysisError,
  splicedAudioBuffer,
  soundName,
  busy = false,
  onBack,
  onAccept,
  onFix,
  isScoringMotion,
  slowBackend = false,
}: CheckShotsStepProps) {
  const { t } = useTranslation()
  const shots = useWizardStore((s) => s.shots)
  const ready = Boolean(mediaAnalysis?.audioBuffer && onsetAnalysis)

  // This line is why the screen exists: the video already plays with the replacement.
  useVideoReplacementAudio(videoRef, splicedAudioBuffer, true)

  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const duration = mediaAnalysis?.duration ?? 0

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onPlay = () => setIsPlaying(true)
    const onPause = () => setIsPlaying(false)
    const onTime = () => setCurrentTime(video.currentTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onPause)
    video.addEventListener('timeupdate', onTime)
    return () => {
      video.removeEventListener('play', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onPause)
      video.removeEventListener('timeupdate', onTime)
    }
  }, [videoRef, videoUrl])

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }, [videoRef])

  // Skip to the next marker, wrapping around: after the last comes the first again. A dead
  // end at the end of the clip would kill the button right where the person is still listening.
  const skipToNextShot = useCallback(() => {
    const video = videoRef.current
    if (!video || shots.length === 0) return
    const next = shots.find((shot) => shot.time > video.currentTime + 0.05) ?? shots[0]
    video.currentTime = next.time
    setCurrentTime(next.time)
  }, [videoRef, shots])

  return (
    <WizardLayout
      step="edit-shots"
      title={t('wizard.checkShots.title') + (slowBackend ? '.' : '')}
      onBack={onBack}
      backLabel={t('wizard.checkShots.back')}
      busy={busy}
      primaryAction={{ label: t('wizard.checkShots.yes'), onClick: onAccept, disabled: !ready || busy }}
      secondaryAction={{ label: t('wizard.checkShots.no'), onClick: onFix, disabled: !ready || busy }}
    >
      <div className="check-shots">
        {shots.length > 0 && (
          <p className="check-shots__found">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M4 10.5l4 4 8-9" />
            </svg>
            {t('wizard.checkShots.found', { count: shots.length })}
          </p>
        )}

        {soundName && (
          <p className="check-shots__swap">
            <i aria-hidden="true" />
            {/* The meme name is highlighted inside the sentence: it's the only variable word
                in it, and the word order around it differs between Russian and English. */}
            <span>
              <Trans
                i18nKey="wizard.checkShots.swap"
                values={{ name: soundName }}
                components={{ b: <b /> }}
              />
            </span>
          </p>
        )}

        <div className="check-shots__media">
          <VideoShotsEditor
            videoUrl={videoUrl}
            videoRef={videoRef}
            mediaAnalysis={mediaAnalysis}
            onsetAnalysis={onsetAnalysis}
            isAnalyzing={isAnalyzing}
            analysisError={analysisError}
            isScoringMotion={isScoringMotion}
            readOnly
          />
        </div>

        {/* One transport per screen — this one. The native video controls are removed along
            with the speed picker: the check has no tools, only playback and skipping. */}
        <div className="check-shots__playbar">
          <button
            type="button"
            className="check-shots__play"
            onClick={togglePlay}
            aria-label={isPlaying ? t('onset.pause') : t('onset.play')}
          >
            {isPlaying ? (
              <svg width="15" height="15" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <rect x="2.5" y="1.5" width="2.5" height="9" rx="0.5" />
                <rect x="7" y="1.5" width="2.5" height="9" rx="0.5" />
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
                <path d="M3 1.5v9l7-4.5z" />
              </svg>
            )}
          </button>

          <span className="check-shots__time">
            <b>{formatTime(currentTime)}</b> / {formatTime(duration)}
          </span>

          {shots.length > 0 && (
            <button type="button" className="check-shots__skip" onClick={skipToNextShot}>
              {t('wizard.checkShots.skip')}
              <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 4l7 6-7 6M15 4v12" />
              </svg>
            </button>
          )}
        </div>

        <p className="check-shots__ask">
          <b>{t('wizard.checkShots.ask')}</b>
          <span>{t('wizard.checkShots.askHint')}</span>
        </p>

        {ready && shots.length === 0 && (
          <p className="wizard__hint">{t('wizard.checkShots.emptyHint')}</p>
        )}
      </div>
    </WizardLayout>
  )
}
