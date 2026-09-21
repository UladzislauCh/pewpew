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
        </div>

        <div className="site-footer__bottom">
          <span className="site-footer__rights">{t('footer.rights', { year })}</span>
          <LanguageSwitcher />
        </div>
      </div>
    </footer>
  )
}
