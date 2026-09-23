import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useSiteStore } from '../shared/store/siteStore'
import { LanguageSwitcher } from '../shared/ui/LanguageSwitcher'
import './SiteFooter.css'

/**
 * Site footer: logo, section links, copyright and language.
 *
 * THE SECOND COLUMN IS FEEDBACK. Each link opens the popup with the right topic preselected:
 * “Report a bug” → “Not working”, “Suggest a sound” → “New sound”. Telegram from the
 * mockup was not carried over: there is no channel, and a link to nowhere is worse than none.
 *
 * THE THIRD COLUMN IS SOCIAL, AND IT STANDS APART FROM FEEDBACK. These two leave the site,
 * those two open the form — mixing them makes a person click “Write to us” expecting YouTube.
 * Real accounts only, same rule as Telegram above.
 *
 * THE LANGUAGE SWITCH DUPLICATES THE HEADER ON PURPOSE. The “How it works” and FAQ pages
 * are long, and for someone who has read to the bottom the switch is closer than the header.
 * There is one state for both places — it lives in i18n, not in the component, so they can't desync.
 */
export function SiteFooter() {
  const { t } = useTranslation()
  const openFeedback = useSiteStore((s) => s.openFeedback)
  const year = new Date().getFullYear()

  return (
    <footer className="site-footer">
      <div className="site-footer__inner">
        <Link className="site-footer__brand" to="/" aria-label={t('header.homeAria')}>
          <picture>
            <source srcSet="/pewpew-mark.webp" type="image/webp" />
            <img className="site-footer__mark" src="/pewpew-mark.png" alt="" width={117} height={144} />
          </picture>
          <span className="site-footer__wordmark">pewpew</span>
        </Link>

        <div className="site-footer__cols">
          <nav className="site-footer__nav" aria-label={t('footer.navAria')}>
            <h2 className="site-footer__title">{t('footer.service')}</h2>
            <Link className="site-footer__link" to="/">{t('footer.upload')}</Link>
            <Link className="site-footer__link" to="/how-it-works">{t('header.howItWorks')}</Link>
            <Link className="site-footer__link" to="/faq">{t('header.faq')}</Link>
          </nav>

          <section className="site-footer__nav" aria-label={t('footer.feedbackAria')}>
            <h2 className="site-footer__title">{t('footer.feedback')}</h2>
            <button type="button" className="site-footer__link" onClick={() => openFeedback('broken')}>
              {t('footer.reportBug')}
            </button>
            <button type="button" className="site-footer__link" onClick={() => openFeedback('sound')}>
              {t('footer.suggestSound')}
            </button>
            <button type="button" className="site-footer__link" onClick={() => openFeedback('idea')}>
              {t('footer.writeUs')}
            </button>
          </section>

          <section className="site-footer__nav site-footer__nav--social" aria-label={t('footer.socialAria')}>
            <h2 className="site-footer__title">{t('footer.social')}</h2>
            <a
              className="site-footer__link"
              href="https://www.youtube.com/@pewpew_baby"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg className="site-footer__icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8zM9.6 15.6V8.4l6.3 3.6-6.3 3.6z" />
              </svg>
              YouTube
            </a>
            <a
              className="site-footer__link"
              href="https://www.tiktok.com/@pewpew.baby"
              target="_blank"
              rel="noopener noreferrer"
            >
              <svg className="site-footer__icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M16.7 5.8a4.9 4.9 0 0 1-1.1-1 5 5 0 0 1-1.2-2.6h-3.3v13.2a2.9 2.9 0 1 1-2.1-2.8V9.3a6.2 6.2 0 1 0 5.4 6.2V8.8a8.2 8.2 0 0 0 4.8 1.5V7a4.9 4.9 0 0 1-2.5-1.2z" />
              </svg>
              TikTok
            </a>
          </section>
        </div>

        <div className="site-footer__bottom">
          <span className="site-footer__rights">{t('footer.rights', { year })}</span>
          <LanguageSwitcher />
        </div>
      </div>
    </footer>
  )
}
