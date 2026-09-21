import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { VideoShotsEditor } from '../components/VideoShotsEditor'
import { useVideoReplacementAudio } from '../model/useVideoReplacementAudio'
import type { OnsetAnalysis } from '../../../domain/detection/onsetDetection'
import type { MediaAnalysis } from '../../../domain/video/mediaAnalysis'
import { useSiteStore } from '../../../shared/store/siteStore'
import { useWizardStore } from '../store/wizardStore'
import { WizardLayout } from '../WizardLayout'
import './EditShotsStep.css'

/**
 * Track window width when jumping to a marker, in seconds.
 *
 * Three seconds isn't a round number for its own sake: on the overview a three-shot burst
 * spans six pixels, neighbouring markers three apart, and hitting the right one is impossible.
 * In a three-second window the same burst stretches to about fifty, a couple dozen between
 * neighbours, and a double-click stops being a lottery.
 */
const FOCUS_WINDOW_SECONDS = 3

/**
 * How much to play when jumping to a marker: before and after it — a CEILING, not the length itself.
 *
 * The actual window is cut by the neighbours, see `previewWindow`.
 */
const PREVIEW_LEAD_SECONDS = 0.35
const PREVIEW_TAIL_SECONDS = 0.65

/**
 * How much to play around a marker so that EXACTLY ONE shot is heard.
 *
 * A fixed one-second window worked for sparse shots and fell apart on bursts: there
 * neighbours are 60–80 ms apart, and “listen to the marker” turned into “listen to five
 * in a row” — you can't tell by ear which one is under review. So the window stops at the
 * midpoint of the gap to the neighbour on each side: past halfway is someone else's
 * territory. A lower bound keeps the window audible when neighbours are packed tight.
 */
const PREVIEW_MIN_SECONDS = 0.09

/** Not every target browser has `findLastIndex` — our own, three lines long. */
function findLastIndex<T>(items: readonly T[], match: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) if (match(items[i])) return i
  return -1
}

function previewWindow(shots: readonly { time: number }[], index: number) {
  const time = shots[index]?.time ?? 0
  const prev = shots[index - 1]?.time
  const next = shots[index + 1]?.time
  const half = (gap: number) => Math.max(PREVIEW_MIN_SECONDS, gap / 2)
  const lead = prev === undefined
    ? PREVIEW_LEAD_SECONDS
    : Math.min(PREVIEW_LEAD_SECONDS, half(time - prev))
  const tail = next === undefined
    ? PREVIEW_TAIL_SECONDS
    : Math.min(PREVIEW_TAIL_SECONDS, half(next - time))
  return { from: Math.max(0, time - lead), duration: lead + tail }
}

interface EditShotsStepProps {
  videoUrl: string
  videoRef: RefObject<HTMLVideoElement | null>
  mediaAnalysis: MediaAnalysis | null
  onsetAnalysis: OnsetAnalysis | null
  isAnalyzing: boolean
  analysisError: string | null
  /** The clip with the meme already spliced in: editing is listened to just like the check. */
  splicedAudioBuffer: AudioBuffer | null
  busy?: boolean
  /** “← Back to check”: go back and re-listen without deciding anything. */
  onBack: () => void
  /**
   * “Done” goes FORWARD, to picking a meme, not back to the check.
   *
   * The edit is itself the answer to the check question: markers are fixed, no need to
   * listen again. Returning to the check put the person in front of the same question a
   * second time — and that read as “you failed”.
   */
  onDone: () => void
  isScoringMotion?: boolean
}

/**
 * Marker editing screen. Opens ONLY on the “no, fix it” answer at the check.
 *
 * HERE THE TRACK IS A TOOL, and zoom makes sense here: the person works on one spot,
 * not the whole clip. Stepping through markers uses buttons, not mouse aiming: precision
 * shouldn't depend on hitting two pixels. A jump sets the zoom itself and plays the
 * surroundings — errors are caught by ear anyway.
 */
export function EditShotsStep({
  videoUrl,
  videoRef,
  mediaAnalysis,
  onsetAnalysis,
  isAnalyzing,
  analysisError,
  splicedAudioBuffer,
  busy = false,
  onBack,
  onDone,
  isScoringMotion,
}: EditShotsStepProps) {
  const { t } = useTranslation()
  const shots = useWizardStore((s) => s.shots)
  const openFeedback = useSiteStore((s) => s.openFeedback)

  useVideoReplacementAudio(videoRef, splicedAudioBuffer, true)

  // Which marker the stepping is on. An index, not a time: the list is re-sorted after
  // every move, and “current” is a position in the walk, not a specific second.
  const [current, setCurrent] = useState(0)
  const [focusTime, setFocusTime] = useState<number | null>(null)

  // A marker may have been removed — the walk must not point past the end of the list.
  useEffect(() => {
    setCurrent((index) => (shots.length === 0 ? 0 : Math.min(index, shots.length - 1)))
  }, [shots.length])

  // Stops the previous playback: without it, rapid “next” presses pile up timers,
  // and a stale one stops the following marker.
  const stopAtRef = useRef<number | null>(null)
  /**
   * The stretch that was just played.
   *
   * In a dense burst markers are 16–80 ms apart, and no window can isolate one by ear:
   * the meme itself is longer than the gap. Since several shots sound together anyway,
   * the walk shouldn't replay them — “next” goes to the first marker PAST the heard
   * stretch, and “prev” to the first one before it. Otherwise the buttons tread water on
   * a burst: every press gives the same mush.
   */
  const heardRef = useRef<{ from: number; until: number } | null>(null)

  const goToShot = useCallback(
    (index: number) => {
      const shot = shots[index]
      if (!shot) return
      setCurrent(index)
      // The field's key is the time itself: jumping to the same marker again re-focuses the view.
      setFocusTime(shot.time)

      const video = videoRef.current
      if (!video) return
      const { from, duration } = previewWindow(shots, index)
      heardRef.current = { from, until: from + duration }
      if (stopAtRef.current !== null) window.clearTimeout(stopAtRef.current)
      video.currentTime = from
      void video.play().catch(() => {
        // Autoplay may be blocked — then it's just a seek.
      })
      stopAtRef.current = window.setTimeout(() => {
        stopAtRef.current = null
        if (!video.paused) video.pause()
      }, duration * 1000)
    },
    [shots, videoRef],
  )

  useEffect(() => () => {
    if (stopAtRef.current !== null) window.clearTimeout(stopAtRef.current)
  }, [])

  // A walk step: past everything already heard, wrapping around at the edges.
  const step = useCallback(
    (direction: 1 | -1) => {
      if (shots.length === 0) return
      const heard = heardRef.current
      // Nothing has played yet, so there's nothing to step past — go from the marker itself to its neighbour.
      const found = heard === null
        ? current + direction
        : direction === 1
          ? shots.findIndex((shot) => shot.time > heard.until)
          : findLastIndex(shots, (shot) => shot.time < heard.from)
      const wrapped = found === -1 || found < 0 || found >= shots.length
        ? direction === 1
          ? 0
          : shots.length - 1
        : found
      goToShot(wrapped)
    },
    [shots, current, goToShot],
  )

  const shotNumber = shots.length === 0 ? 0 : Math.min(current, shots.length - 1) + 1
  const currentShot = shots[shotNumber - 1]
  // At the edges the walk wraps, and the button says WHERE it will go: from the last
  // marker “next” leads to the first and is labelled “first”. Otherwise the arrow promises
  // a continuation where there is none.
  const atFirst = shotNumber === 1
  const atLast = shotNumber === shots.length

  return (
    <WizardLayout
      step="edit-shots"
      title={t('wizard.editShots.title')}
      onBack={onBack}
      backLabel={t('wizard.editShots.back')}
      busy={busy}
      primaryAction={{ label: t('wizard.editShots.done'), onClick: onDone, disabled: busy }}
      footerNote={
        <>
          {t('wizard.editShots.reportLead')}{' '}
          <button type="button" className="wizard__footer-link" onClick={() => openFeedback('marks')}>
            {t('wizard.editShots.reportLink')}
          </button>
        </>
      }
    >
      <div className="edit-shots">
        <div className="edit-shots__media">
          <VideoShotsEditor
            videoUrl={videoUrl}
            videoRef={videoRef}
            mediaAnalysis={mediaAnalysis}
            onsetAnalysis={onsetAnalysis}
            isAnalyzing={isAnalyzing}
            analysisError={analysisError}
            isScoringMotion={isScoringMotion}
            focusTime={focusTime}
            focusZoomSeconds={FOCUS_WINDOW_SECONDS}
          />
        </div>

        {shots.length > 0 && (
          <div className="edit-shots__hop">
            <button type="button" onClick={() => step(-1)}>
              {atFirst ? t('wizard.editShots.last') : t('wizard.editShots.prev')}
            </button>
            <span className="edit-shots__who">
              <b>{currentShot ? currentShot.time.toFixed(3) : '—'}</b>
              {t('wizard.editShots.position', { index: shotNumber, total: shots.length })}
            </span>
            <button type="button" onClick={() => step(1)}>
              {atLast ? t('wizard.editShots.first') : t('wizard.editShots.next')}
            </button>
          </div>
        )}

        <p className="edit-shots__hint">
          {shots.length > 0 ? t('wizard.editShots.hint') : t('wizard.editShots.emptyHint')}
        </p>
      </div>
    </WizardLayout>
  )
}
