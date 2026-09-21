import { useTranslation } from 'react-i18next'
import { useSiteStore } from '../shared/store/siteStore'
import './FaqPage.css'

function Chevron() {
  return (
    <svg
      className="faq-page__chevron"
      width="15"
      height="15"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M5 8l5 5 5-5" />
    </svg>
  )
}

export function FaqPage() {
  const { t } = useTranslation()
  const openFeedback = useSiteStore((s) => s.openFeedback)

  return (
    <main className="faq-page">
      <header>
        <h1 className="faq-page__title">{t('faq.title')}</h1>
        <p className="faq-page__lead">{t('faq.lead')}</p>
      </header>

      <div className="faq-page__list">
        <details className="faq-page__item" open>
          <summary className="faq-page__question">
            <span className="faq-page__question-text">{t('faq.items.shotDetection.question')}</span>
            <Chevron />
          </summary>
          <p className="faq-page__answer">{t('faq.items.shotDetection.answer')}</p>
        </details>

        <details className="faq-page__item">
          <summary className="faq-page__question">
            <span className="faq-page__question-text">{t('faq.items.linkOnly.question')}</span>
            <Chevron />
          </summary>
          <p className="faq-page__answer">
            {t('faq.items.linkOnly.answerBefore')}{' '}
            <a
              className="faq-page__link"
              href="https://savefrom.net"
              target="_blank"
              rel="noopener noreferrer"
            >
              savefrom.net
            </a>
            {t('faq.items.linkOnly.answerAfter')}
          </p>
        </details>

        <details className="faq-page__item">
          <summary className="faq-page__question">
            <span className="faq-page__question-text">{t('faq.items.videoPrivacy.question')}</span>
            <Chevron />
          </summary>
          <p className="faq-page__answer">{t('faq.items.videoPrivacy.answer')}</p>
        </details>

        <details className="faq-page__item">
          <summary className="faq-page__question">
            <span className="faq-page__question-text">{t('faq.items.customSound.question')}</span>
            <Chevron />
          </summary>
          <p className="faq-page__answer">{t('faq.items.customSound.answer')}</p>
        </details>
      </div>

      {/* The FAQ covers the common questions; everything else needs a way out, or the person just leaves. */}
      <div className="faq-page__contact">
        <p className="faq-page__contact-lead">{t('faq.contactLead')}</p>
        <button type="button" className="faq-page__contact-cta" onClick={() => openFeedback('idea')}>
          {t('faq.contactCta')}
        </button>
      </div>
    </main>
  )
}
