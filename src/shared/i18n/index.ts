import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'
import ru from './locales/ru.json'

export const SUPPORTED_LANGS = ['en', 'ru'] as const
export type AppLanguage = (typeof SUPPORTED_LANGS)[number]

export const DEFAULT_LANG: AppLanguage = 'en'
export const LANG_STORAGE_KEY = 'pewpew.lang'

const resources = {
  en: { translation: en },
  ru: { translation: ru },
} as const

function isAppLanguage(value: string): value is AppLanguage {
  return (SUPPORTED_LANGS as readonly string[]).includes(value)
}

/** Preference from localStorage, else default English. */
export function readStoredLanguage(): AppLanguage {
  try {
    const stored = localStorage.getItem(LANG_STORAGE_KEY)
    if (stored && isAppLanguage(stored)) return stored
  } catch {
    // private mode / blocked storage
  }
  return DEFAULT_LANG
}

export function persistLanguage(lang: AppLanguage): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {
    // ignore
  }
}

/**
 * Page language and meta tags. WITHOUT A DOCUMENT it silently does nothing.
 *
 * This module exports the i18n instance itself, so anything that needs a translation
 * pulls it in — including pure modules like `wizard/model/problemCopy`, which by design
 * must run in Node: vitest checks them without jsdom. While the page wiring sat here
 * unconditionally, every such import crashed with `document is not defined` while the
 * module was still being evaluated, before a single line of the test ran.
 *
 * The check lives INSIDE the function, not around the call below: that way it can't be
 * forgotten, and nothing changes for callers — in the browser the document always exists.
 */
export function applyDocumentLanguage(lang: AppLanguage): void {
  if (typeof document === 'undefined') return

  document.documentElement.lang = lang

  const title = i18n.t('meta.title', { lng: lang })
  const description = i18n.t('meta.description', { lng: lang })

  document.title = title

  const metaDescription = document.querySelector('meta[name="description"]')
  if (metaDescription) metaDescription.setAttribute('content', description)

  const ogTitle = document.querySelector('meta[property="og:title"]')
  if (ogTitle) ogTitle.setAttribute('content', title)

  const ogDescription = document.querySelector('meta[property="og:description"]')
  if (ogDescription) ogDescription.setAttribute('content', description)
}

void i18n.use(initReactI18next).init({
  resources,
  lng: readStoredLanguage(),
  fallbackLng: DEFAULT_LANG,
  supportedLngs: [...SUPPORTED_LANGS],
  interpolation: {
    escapeValue: false,
  },
})

applyDocumentLanguage(i18n.language as AppLanguage)

i18n.on('languageChanged', (lng) => {
  if (isAppLanguage(lng)) applyDocumentLanguage(lng)
})

export default i18n
