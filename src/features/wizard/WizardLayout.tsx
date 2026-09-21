import { useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useWizardStore } from './store/wizardStore'
import { StepsBar } from './StepsBar'
import type { WizardStep } from './model/types'
import './WizardLayout.css'

interface WizardPrimaryAction {
  label: string
  onClick: () => void
  disabled?: boolean
  /** When set (0..1), renders a progress fill inside the primary button. */
  progress?: number
}

interface WizardLayoutProps {
  /** Which step this is. The screen knows itself — otherwise the step bar would have to be fed from above. */
  step: WizardStep
  title?: string
  /** Caption under the title. A node, not a string: on the waiting screen it has two parts —
      a truncatable file name and a duration that must not be truncated. */
  hint?: ReactNode
  children: ReactNode
  /**
   * Rendered under the main content (outside the busy overlay) — e.g. start-over action.
   */
  belowContent?: ReactNode
  onBack?: () => void
  /** Destination name, e.g. “New clip”, “Another meme”. */
  backLabel?: string
  primaryAction?: WizardPrimaryAction
  /**
   * A quiet second answer BELOW the primary button: “no, fix it” on the check screen.
   *
   * Not in `belowContent`: that sits above the footer, so “no” would end up ABOVE “yes”.
   * The mockup has it the other way round — primary answer first, fallback below.
   */
  secondaryAction?: { label: string; onClick: () => void; disabled?: boolean }
  /** A quiet line under the buttons — a fallback path, e.g. “Shots not caught? Let us know”. */
  footerNote?: ReactNode
  /**
   * Soft-blocks only the main content area (children). Header, back, belowContent and footer
   * stay interactive so the user can cancel.
   */
  busy?: boolean
}

export function WizardLayout({
  step,
  title,
  hint,
  children,
  belowContent,
  onBack,
  backLabel,
  primaryAction,
  secondaryAction,
  footerNote,
  busy = false,
}: WizardLayoutProps) {
  const { t } = useTranslation()
  // Rendered means reached. This can't be recorded in navigation: the step lands there
  // BEFORE the screen is built, and on a cancelled transition the bar would run ahead.
  const markStepReached = useWizardStore((s) => s.markStepReached)
  useEffect(() => {
    markStepReached(step)
  }, [step, markStepReached])

  const resolvedBackLabel = backLabel ?? t('wizard.backDefault')
  const progress =
    primaryAction?.progress !== undefined
      ? Math.min(1, Math.max(0, primaryAction.progress))
      : undefined

  return (
    <>
      {/* The step band is part of the top chrome, not the content column: it must span
          the full width, like the header. So it's a SIBLING of `.wizard`, not its child —
          otherwise the 640-pixel column would clip it. */}
      <div className="wizard-steps-band">
        <div className="wizard-steps-band__inner">
          <StepsBar current={step} />
        </div>
      </div>
      <div className="wizard" aria-busy={busy || undefined}>
        <main className="wizard__main">
        {(title || hint || onBack) && (
          <div className="wizard__intro">
            <div className={`wizard__intro-head${onBack ? ' wizard__intro-head--with-back' : ''}`}>
              {onBack && (
                <button type="button" className="wizard__back" onClick={onBack}>
                  <span className="wizard__back-arrow" aria-hidden="true">
                    ←
                  </span>
                  {resolvedBackLabel}
                </button>
              )}
              {title && <h1 className="wizard__title">{title}</h1>}
            </div>
            {hint && <p className="wizard__hint">{hint}</p>}
          </div>
        )}

        <div
          className={busy ? 'wizard__content wizard__content--busy' : 'wizard__content'}
          inert={busy || undefined}
        >
          {children}
          {busy && (
            <div className="wizard__busy" role="status" aria-live="polite">
              <div className="wizard__spinner" aria-hidden="true" />
              <p className="wizard__busy-label">{t('wizard.busy')}</p>
            </div>
          )}
        </div>

        {belowContent}
      </main>

      {(primaryAction || secondaryAction) && (
        <footer className="wizard__footer">
          {primaryAction && (
            <button
              type="button"
              className={
                progress !== undefined ? 'wizard__primary wizard__primary--progress' : 'wizard__primary'
              }
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
            >
              {progress !== undefined && (
                <span
                  className="wizard__primary-bar"
                  style={{ width: `${Math.round(progress * 100)}%` }}
                  aria-hidden="true"
                />
              )}
              <span className="wizard__primary-label">{primaryAction.label}</span>
            </button>
          )}
          {secondaryAction && (
            <button
              type="button"
              className="wizard__secondary"
              onClick={secondaryAction.onClick}
              disabled={secondaryAction.disabled}
            >
              {secondaryAction.label}
            </button>
          )}
          {footerNote && <p className="wizard__footer-note">{footerNote}</p>}
        </footer>
      )}
      </div>
    </>
  )
}
