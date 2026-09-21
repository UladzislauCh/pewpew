import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { MediaAnalysis } from '../../../domain/video/mediaTypes'
import {
  estimateAnalysisSeconds,
  FINISH_MS,
  HOLD_MS,
  progressAt,
  remainingSeconds,
} from '../model/analysisProgress'
import { WizardLayout } from '../WizardLayout'
import './AnalyzingStep.css'

interface AnalyzingStepProps {
  fileName: string
  mediaAnalysis: MediaAnalysis | null
  /** Whether container parsing is still running — the first phase. */
  isAnalyzing: boolean
  /** Whether shot detection is running — the second phase. */
  isDetecting: boolean
  foundShots: number | null
  onCancel: () => void
  /** The bar has reached the end: OK to move to the next step. */
  onFinished: () => void
}

type PhaseState = 'done' | 'run' | 'wait'

/**
 * The waiting screen.
 *
 * WHY IT EXISTS. Analysis takes about 60% of the clip's length, and on 60 fps clips —
 * longer than the clip itself. All that time the upload screen used to be covered by an
 * overlay with a single word: not what's happening, not how long is left, not how to leave.
 *
 * PHASES ARE NAMED BY OUTCOME, NOT BY METHOD. “Finding shots”, not “reading the ammo
 * counter”: how they're found is none of the user's business, and the mechanism can
 * change without rewriting the screen.
 */
export function AnalyzingStep({
  fileName,
  mediaAnalysis,
  isAnalyzing,
  isDetecting,
  foundShots,
  onCancel,
  onFinished,
}: AnalyzingStepProps) {
  const { t } = useTranslation()
  // The countdown starts when the ESTIMATE becomes known, not when the screen appears:
  // before that the container is being read, and those seconds aren't part of the estimate.
  const startedAt = useRef<number | null>(null)
  const doneAt = useRef<number | null>(null)
  const doneValue = useRef(0)
  const finished = useRef(false)
  const percentRef = useRef(0)
  const [percent, setPercent] = useState(0)
  const [left, setLeft] = useState<number | null>(null)

  const duration = mediaAnalysis?.duration ?? null
  const estimateMs =
    duration === null
      ? 0
      : estimateAnalysisSeconds(duration, mediaAnalysis?.video?.frameRate ?? null) * 1000
  const working = isAnalyzing || isDetecting

  /*
   * THE BAR IS DRIVEN BY A TIMER, NOT `requestAnimationFrame`.
   *
   * Browsers throttle animation frames: in a background tab, in power-saving mode and in
   * some in-app browsers they arrive once a second or less. Verified right here: the bar
   * sat at zero while analysis ran. Hence a 100 ms timer — a CSS transition supplies the
   * smoothness, and accuracy comes from the clock anyway, not from a frame count.
   */
  useEffect(() => {
    const tick = () => {
      if (estimateMs > 0 && startedAt.current === null) startedAt.current = performance.now()
      const elapsed = startedAt.current === null ? 0 : performance.now() - startedAt.current
      // The completion moment is recorded once, together with the fraction it caught:
      // the run-out of the remainder is computed from it, otherwise the bar jerks on skipped ticks.
      if (!working && doneAt.current === null) {
        doneAt.current = elapsed
        doneValue.current = percentRef.current
      }
      const value = progressAt({
        elapsedMs: elapsed,
        estimateMs,
        doneAtMs: doneAt.current,
        doneAtValue: doneValue.current,
      })
      percentRef.current = value
      setPercent(value)
      // Seconds are derived FROM THE BAR FRACTION: both show the same thing,
      // and there's nothing for them to drift on.
      setLeft(estimateMs > 0 ? remainingSeconds(value, estimateMs) : null)

      if (doneAt.current !== null && elapsed - doneAt.current >= FINISH_MS + HOLD_MS && !finished.current) {
        finished.current = true
        onFinished()
      }
    }
    tick()
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [working, estimateMs, onFinished])

  /*
   * PHASES GO STRICTLY IN ORDER, AND THE BOUNDARY BETWEEN THE SECOND AND THIRD IS 100 PERCENT.
   *
   * Not the end of the work: work can finish at any fraction, and the bar then takes another
   * half second to run up to a hundred. If the third phase opened at the end of work,
   * “placing the sound” would start spinning while “finding shots” still showed 84% — two
   * phases at once. Both points are merged into one: while `percent < 1` detection is on;
   * at a hundred it closes and sound placement begins.
   *
   * `percent >= 1` by itself means the work is done: while it's running, the bar is capped
   * at 97% and by construction never reaches a hundred.
   */
  const complete = percent >= 1
  const phases: { key: string; state: PhaseState; value: string }[] = [
    {
      key: 'read',
      state: isAnalyzing ? 'run' : 'done',
      value: duration === null ? '…' : t('analyzing.seconds', { value: duration.toFixed(1) }),
    },
    {
      key: 'search',
      state: isAnalyzing ? 'wait' : complete ? 'done' : 'run',
      value: isAnalyzing ? t('analyzing.waiting') : `${Math.round(percent * 100)}%`,
    },
    {
      key: 'place',
      state: complete ? 'run' : 'wait',
      value: complete ? '…' : t('analyzing.waiting'),
    },
  ]

  return (
    <WizardLayout
      step="upload"
      title={t('analyzing.title')}
      /* Screen caption: file name and duration, as in the mockup. The name is one line
         with an ellipsis: clips from social media can have paragraph-long names. The duration
         is a separate piece, otherwise the ellipsis would eat it too. */
      hint={
        <span className="analyzing__file">
          <span className="analyzing__file-name" title={fileName}>
            {fileName}
          </span>
          {duration !== null && (
            <span className="analyzing__file-time">
              · {t('analyzing.seconds', { value: duration.toFixed(1) })}
            </span>
          )}
        </span>
      }
    >
      {/* All content in ONE block: `.wizard__content` spaces its children with a 14-pixel
          gap, and that added up with the margins inside — every gap came out
          exactly 14 larger than the mockup. */}
      <div className="analyzing">

      <ol className="analyzing__phases">
        {phases.map((phase) => (
          <li key={phase.key} className={`analyzing__phase analyzing__phase--${phase.state}`}>
            <PhaseIcon state={phase.state} />
            <span className="analyzing__phase-name">{t(`analyzing.phase.${phase.key}`)}</span>
            <span className="analyzing__phase-value">{phase.value}</span>
          </li>
        ))}
      </ol>

      <div
        className="analyzing__bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent * 100)}
      >
        <i style={{ width: `${percent * 100}%` }} />
      </div>

      <p className="analyzing__row">
        <span>
          {foundShots === null
            ? t('analyzing.searching')
            : t('analyzing.found', { count: foundShots })}
        </span>
        {/* The promise doesn't vanish when work ends but counts down to zero with the bar:
            disappearing at “~18 s left” means breaking off mid-sentence. At zero, “done”
            replaces “~0 s left”: a zero with a tilde reads like an error. */}
        {left !== null && (
          <span>{left === 0 ? t('analyzing.ready') : t('analyzing.left', { value: left })}</span>
        )}
      </p>

        <button type="button" className="analyzing__cancel" onClick={onCancel}>
          {t('analyzing.cancel')}
        </button>
      </div>
    </WizardLayout>
  )
}

function PhaseIcon({ state }: { state: PhaseState }) {
  if (state === 'done') {
    return (
      <svg className="analyzing__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M4 10.5l4 4 8-9" />
      </svg>
    )
  }
  if (state === 'run') {
    return (
      <svg className="analyzing__icon analyzing__icon--spin" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.1 5.1l2.1 2.1M12.8 12.8l2.1 2.1M14.9 5.1l-2.1 2.1M7.2 12.8l-2.1 2.1" />
      </svg>
    )
  }
  return (
    <svg className="analyzing__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="10" cy="10" r="7" />
    </svg>
  )
}
