import { useTranslation } from 'react-i18next'
import {
  persistLanguage,
  SUPPORTED_LANGS,
  type AppLanguage,
  DEFAULT_LANG,
} from '../i18n'
import './LanguageSwitcher.css'

const LABELS: Record<AppLanguage, string> = {
  en: 'EN',
  ru: 'RU',
}

function resolveLanguage(lng: string | undefined): AppLanguage {
  const base = (lng ?? DEFAULT_LANG).split('-')[0]
  return (SUPPORTED_LANGS as readonly string[]).includes(base)
    ? (base as AppLanguage)
    : DEFAULT_LANG
}

export function LanguageSwitcher() {
  const { i18n, t } = useTranslation()
  const current = resolveLanguage(i18n.resolvedLanguage ?? i18n.language)

  const setLanguage = (lang: AppLanguage) => {
    if (lang === current) return
    persistLanguage(lang)
    void i18n.changeLanguage(lang)
  }

  return (
    <div className="lang-switcher" role="group" aria-label={t('header.language')}>
      {SUPPORTED_LANGS.map((lang) => (
        <button
          key={lang}
          type="button"
          className={
            lang === current
              ? 'lang-switcher__btn lang-switcher__btn--active'
              : 'lang-switcher__btn'
          }
          aria-pressed={lang === current}
          onClick={() => setLanguage(lang)}
        >
          {LABELS[lang]}
        </button>
      ))}
    </div>
  )
}
