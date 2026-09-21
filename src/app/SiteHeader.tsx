import { useEffect, useId, useRef } from 'react'
import { Link, NavLink, useLocation } from 'react-router'
import { useTranslation } from 'react-i18next'
import { useSiteStore } from '../shared/store/siteStore'
import { LanguageSwitcher } from '../shared/ui/LanguageSwitcher'
import './SiteHeader.css'

export function SiteHeader() {
  const { t } = useTranslation()
  const location = useLocation()
  const navId = useId()
  const actionsRef = useRef<HTMLDivElement>(null)
  // The flag lives in the site store: three different things close the menu, and one
  // of them comes from outside the header — a route change.
  const menuOpen = useSiteStore((s) => s.isMenuOpen)
  const toggleMenu = useSiteStore((s) => s.toggleMenu)
  const closeMenu = useSiteStore((s) => s.closeMenu)
  const openFeedback = useSiteStore((s) => s.openFeedback)

  const nav = [
    { to: '/how-it-works', label: t('header.howItWorks') },
    { to: '/faq', label: t('header.faq') },
  ] as const

  useEffect(() => {
    closeMenu()
  }, [location.pathname, closeMenu])

  useEffect(() => {
    if (!menuOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMenu()
    }

    const onPointerDown = (event: PointerEvent) => {
      const root = actionsRef.current
      if (root && !root.contains(event.target as Node)) {
        closeMenu()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [menuOpen, closeMenu])

  return (
    <header className="site-header">
      <div className="site-header__inner">
        <Link className="site-header__brand" to="/" aria-label={t('header.homeAria')}>
          {/* The header logo is the only image on app entry, and it used to weigh more
              than everything else combined: 780 KB to be shown 36 pixels tall. Now it's
              a 6 KB webp with a 21 KB png fallback. */}
          <picture>
            <source srcSet="/pewpew-mark.webp" type="image/webp" />
            <img className="site-header__mark" src="/pewpew-mark.png" alt="" width={117} height={144} />
          </picture>
          <span className="site-header__wordmark">pewpew</span>
          <span className="site-header__beta">{t('header.beta')}</span>
        </Link>

        <div className="site-header__actions" ref={actionsRef}>
          <button
            type="button"
            className={
              menuOpen
                ? 'site-header__menu-btn site-header__menu-btn--open'
                : 'site-header__menu-btn'
            }
            aria-expanded={menuOpen}
            aria-controls={navId}
            aria-label={menuOpen ? t('header.menuClose') : t('header.menuOpen')}
            onClick={toggleMenu}
          >
            <span className="site-header__menu-icon" aria-hidden="true" />
          </button>

          <nav
            id={navId}
            className={
              menuOpen ? 'site-header__nav site-header__nav--open' : 'site-header__nav'
            }
            aria-label={t('header.navAria')}
          >
            {nav.map((item) => (
              <NavLink
                key={item.to}
                className={({ isActive }) =>
                  isActive ? 'site-header__link site-header__link--active' : 'site-header__link'
                }
                to={item.to}
                onClick={closeMenu}
              >
                {item.label}
              </NavLink>
            ))}
            {/* A button, not a link: feedback is a popup over the current page, not a route. */}
            <button
              type="button"
              className="site-header__link site-header__link--button"
              onClick={() => {
                closeMenu()
                openFeedback('idea')
              }}
            >
              {t('header.feedback')}
            </button>
          </nav>

          <LanguageSwitcher />
        </div>
      </div>
    </header>
  )
}
