import { Link } from 'react-router'
import { useTranslation } from 'react-i18next'
import { DEFAULT_LANG, SUPPORTED_LANGS, type AppLanguage } from '../shared/i18n'
import { getMediaLimitCopy } from '../features/wizard'
import './HowItWorksPage.css'

function resolveLanguage(lng: string | undefined): AppLanguage {
  const base = (lng ?? DEFAULT_LANG).split('-')[0]
  return (SUPPORTED_LANGS as readonly string[]).includes(base)
    ? (base as AppLanguage)
    : DEFAULT_LANG
}

/**
 * Page steps. The first two and last two are wizard steps (Clip · Check ·
 * Meme · Loot), with marker editing in between: in the wizard it isn't a separate step
 * but the “no” answer to the check question, yet it has to be explained — otherwise
 * people never learn that markers can be moved at all.
 *
 * The IDs match the wizard steps on purpose: once they drift, the page starts
 * describing an interface that doesn't exist (which is what happened with “place
 * the markers” after the step became a listening check).
 */
const STEP_IDS = ['upload', 'check', 'fix', 'sound', 'loot'] as const

export function HowItWorksPage() {
  const { t, i18n } = useTranslation()
  const lang = resolveLanguage(i18n.resolvedLanguage ?? i18n.language)
  const limits = getMediaLimitCopy()

  // Screenshots are cut by `scripts/pageShots.ts` — one command for both languages, the
  // crop is computed from the block's own rectangle, not tuned by hand.
  //
  // WEBP, NOT PNG. The shots are double resolution, and as png the ten of them weighed
  // 3.8 MB — brotli doesn't compress them, so that's pure page weight. As webp the same
  // shots take 0.8 MB. No png fallback on purpose: the app needs WebCodecs, and no browser
  // supports that without also supporting webp.
  const images: Record<(typeof STEP_IDS)[number], string> = {
    upload: `/${lang}/01-upload.webp`,
    check: `/${lang}/02-check.webp`,
    fix: `/${lang}/03-fix.webp`,
    sound: `/${lang}/04-sound.webp`,
    loot: `/${lang}/05-loot.webp`,
  }

  /*
   * Limits sit AT THE STEP THEY BELONG TO, not in a single line at the bottom.
   * At the bottom only those who read to the end saw them, while “will my file work?”
   * comes up at the very first step. Values come from the same `MEDIA_LIMITS` that
   * actually check the file — there's nothing for them to drift on.
   */
  const stepLimits: Partial<Record<(typeof STEP_IDS)[number], string[]>> = {
    upload: [
      limits.video.formats,
      t('how.upTo', { value: limits.video.size }),
      t('how.upTo', { value: limits.video.duration }),
    ],
    sound: [
      limits.audio.formats,
      t('how.upTo', { value: limits.audio.size }),
      t('how.upTo', { value: limits.audio.duration }),
      t('how.voiceUpTo', { value: limits.recording.duration }),
    ],
  }

  return (
    <main className="how-page">
      <header>
        <h1 className="how-page__title">{t('how.title')}</h1>
        <p className="how-page__lead">{t('how.lead')}</p>
      </header>

      <ol className="how-page__steps">
        {STEP_IDS.map((id, index) => (
          <li key={id} className="how-page__step">
            <span className="how-page__step-num" aria-hidden="true">
              {index + 1}
            </span>
            <div className="how-page__step-body">
              <h2 className="how-page__step-title">{t(`how.steps.${id}.title`)}</h2>
              <p className="how-page__text">{t(`how.steps.${id}.body`)}</p>

              <figure className="how-page__figure">
                <img
                  key={lang}
                  className="how-page__shot"
                  src={images[id]}
                  alt={t(`how.steps.${id}.alt`)}
                  loading="lazy"
                />
              </figure>

              {stepLimits[id] && (
                <ul className="how-page__limits">
                  {stepLimits[id]?.map((value) => (
                    <li key={value}>{value}</li>
                  ))}
                </ul>
              )}

              {id === 'loot' && <p className="how-page__outro">{t('how.steps.loot.outro')}</p>}
            </div>
          </li>
        ))}
      </ol>

      <Link className="how-page__cta" to="/">
        {t('how.cta')}
      </Link>
    </main>
  )
}
