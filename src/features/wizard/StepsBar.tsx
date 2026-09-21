import { useTranslation } from 'react-i18next'
import { useWizardStore } from './store/wizardStore'
import { stepIndex, WIZARD_STEPS, type WizardStep } from './model/types'

/**
 * Step bar: where the person is now, what's behind and how much is left.
 *
 * THREE STATES, AND THE LINE BETWEEN THEM IS NOT THE CURRENT STEP:
 *
 *   done        — index below the furthest step reached;
 *   current     — the one we're on;
 *   unavailable — beyond what was reached, not allowed yet.
 *
 * The difference shows on going back: returning from sound to markers makes markers
 * current, while sound stays DONE rather than becoming unavailable. The current step
 * alone can't reconstruct that, so progress lives in the `stepsSlice` slice.
 *
 * The bar only displays. It doesn't navigate: going back has its own button naming
 * the destination, and jumping forward over unfilled steps makes no sense.
 */
export function StepsBar({ current }: { current: WizardStep }) {
  const { t } = useTranslation()
  const reached = useWizardStore((s) => s.reachedStep)
  const reachedAt = stepIndex(reached)
  const currentAt = stepIndex(current)

  return (
    <ol className="wizard__steps" aria-label={t('wizard.stepsAria')}>
      {WIZARD_STEPS.map((id, index) => {
        // NON-STRICT comparison: the reached step itself counts as done. With a strict one
        // the third step showed as unavailable after going back to markers, though the person had been there.
        const state =
          index === currentAt ? 'current' : index <= reachedAt ? 'done' : 'locked'
        return (
          <li
            key={id}
            className={`wizard__step wizard__step--${state}`}
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span className="wizard__step-label">
              <span className="wizard__step-num">{index + 1}</span>
              {t(`wizard.steps.${id}`)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}
