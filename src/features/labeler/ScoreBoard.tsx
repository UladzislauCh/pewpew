import type { CategoryRecall, DetectionScore } from '../../domain/detection/detectionMetrics'

interface ScoreBoardProps {
  score: {
    at50: DetectionScore
    at25: DetectionScore
    ignoredTotal: number
    categories: CategoryRecall[]
  }
}

function percent(value: number): string {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : '—'
}

function milliseconds(value: number): string {
  return Number.isFinite(value) ? `${(value * 1000).toFixed(1)} ms` : '—'
}

/**
 * Live scoring of the current detector against the annotations being written, so the effect of a
 * correction is visible immediately rather than after a separate offline run.
 */
export function ScoreBoard({ score }: ScoreBoardProps) {
  const { at50, at25, ignoredTotal, categories } = score
  const edits = at50.falsePositives + at50.falseNegatives

  return (
    <section className="scoreboard">
      <div className="scoreboard__group">
        <span className="scoreboard__title">Assistant vs. own shots, tolerance ±50 ms</span>
        <div className="scoreboard__stats">
          <span>
            F1 <strong>{percent(at50.f1)}</strong>
          </span>
          <span>
            precision <strong>{percent(at50.precision)}</strong>
          </span>
          <span>
            recall <strong>{percent(at50.recall)}</strong>
          </span>
          <span className="scoreboard__muted">
            TP {at50.truePositives} · FP {at50.falsePositives} · FN {at50.falseNegatives} · edits{' '}
            {edits}
          </span>
          <span className="scoreboard__muted">median |Δt| {milliseconds(at50.medianAbsDelta)}</span>
          <span className="scoreboard__muted">enemy shots labeled: {ignoredTotal}</span>
        </div>
      </div>

      <div className="scoreboard__group">
        <span className="scoreboard__title">Tolerance ±25 ms</span>
        <div className="scoreboard__stats">
          <span>
            F1 <strong>{percent(at25.f1)}</strong>
          </span>
          <span className="scoreboard__muted">
            TP {at25.truePositives} · FP {at25.falsePositives} · FN {at25.falseNegatives}
          </span>
        </div>
      </div>

      <div className="scoreboard__group">
        <span className="scoreboard__title">Recall by category</span>
        <div className="scoreboard__stats">
          {categories.map((category) => (
            <span key={category.label}>
              {category.label}{' '}
              <strong>{category.total === 0 ? '—' : percent(category.recall)}</strong>
              <span className="scoreboard__muted">
                {' '}
                ({category.matched}/{category.total})
              </span>
            </span>
          ))}
        </div>
      </div>
    </section>
  )
}
