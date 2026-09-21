import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useSiteStore } from '../shared/store/siteStore'
import './StatusPage.css'

type StatusKind = 'notFound' | 'serverError'

interface StatusPageProps {
  kind: StatusKind
  /** Shown for runtime 500s from the error boundary. */
  onRetry?: () => void
}

export function StatusPage({ kind, onRetry }: StatusPageProps) {
  const { t } = useTranslation()
  const openFeedback = useSiteStore((s) => s.openFeedback)
  const code = kind === 'notFound' ? '404' : '500'
  const prefix = kind === 'notFound' ? 'errors.notFound' : 'errors.server'

  return (
    <main className="status-page" aria-labelledby="status-page-title">
      <div className="status-page__mascot" aria-hidden="true">
        <picture>
          <source srcSet="/roasted-chicken.webp" type="image/webp" />
          <img
            className="status-page__chicken"
            src="/roasted-chicken.png"
            alt=""
            width={140}
            height={140}
          />
        </picture>
      </div>
      <p className="status-page__code">{code}</p>
      <h1 id="status-page-title" className="status-page__title">
        {t(`${prefix}.title`)}
      </h1>
      <p className="status-page__lead">{t(`${prefix}.lead`)}</p>

      <div className="status-page__actions">
        {onRetry && (
          <button type="button" className="status-page__cta" onClick={onRetry}>
            {t('errors.server.retry')}
          </button>
        )}
        <Link
          className={onRetry ? 'status-page__cta status-page__cta--ghost' : 'status-page__cta'}
          to="/"
        >
          {t('errors.home')}
        </Link>
        {/* On a 404 the address is at fault — reporting a broken link is the second button. */}
        {kind === 'notFound' && (
          <button
            type="button"
            className="status-page__cta status-page__cta--ghost"
            onClick={() => openFeedback('broken')}
          >
            {t('errors.notFound.report')}
          </button>
        )}
      </div>

      {/* On a 500 we broke: “Try again” comes first, the report is a quiet line below it. */}
      {kind === 'serverError' && (
        <p className="status-page__report">
          {t('errors.server.reportLead')}{' '}
          <button type="button" className="status-page__report-link" onClick={() => openFeedback('broken')}>
            {t('errors.server.reportLink')}
          </button>
        </p>
      )}
    </main>
  )
}

export function NotFoundPage() {
  return <StatusPage kind="notFound" />
}

export function ServerErrorPage({ onRetry }: { onRetry?: () => void }) {
  return <StatusPage kind="serverError" onRetry={onRetry} />
}
