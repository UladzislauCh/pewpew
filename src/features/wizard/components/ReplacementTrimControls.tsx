import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import './ReplacementTrimControls.css'

const THRESHOLD_MIN = 0.01
const THRESHOLD_MAX = 0.6

interface ReplacementTrimControlsProps {
  thresholdRatio: number
  onChange: (thresholdRatio: number) => void
  /** Trimmed length of the replacement sound — the number shown to the right of the heading. */
  durationSec: number | null
}

/** Maps stored threshold (higher = shorter) to slider position (right = longer). */
function thresholdToSlider(thresholdRatio: number): number {
  return THRESHOLD_MAX + THRESHOLD_MIN - thresholdRatio
}

function sliderToThreshold(sliderValue: number): number {
  return THRESHOLD_MAX + THRESHOLD_MIN - sliderValue
}

export function ReplacementTrimControls({
  thresholdRatio,
  onChange,
  durationSec,
}: ReplacementTrimControlsProps) {
  const { t } = useTranslation()
  const sliderValue = thresholdToSlider(thresholdRatio)
  const percent = ((sliderValue - THRESHOLD_MIN) / (THRESHOLD_MAX - THRESHOLD_MIN)) * 100

  return (
    <div className="trim-slider">
      <div className="trim-slider__label">
        <span className="trim-slider__title">{t('trim.label')}</span>
        {durationSec !== null && (
          <span className="trim-slider__value">
            {t('trim.value', { seconds: durationSec.toFixed(2) })}
          </span>
        )}
      </div>
      <input
        type="range"
        className="trim-slider__input"
        min={THRESHOLD_MIN}
        max={THRESHOLD_MAX}
        step={0.01}
        value={sliderValue}
        onChange={(event) => onChange(sliderToThreshold(Number(event.target.value)))}
        style={{ '--fill': `${percent}%` } as CSSProperties}
        aria-label={t('trim.label')}
      />
      <p className="trim-slider__hint">{t('trim.hint')}</p>
    </div>
  )
}
