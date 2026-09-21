import { useEffect } from 'react'
import { Outlet, Route, Routes, useLocation } from 'react-router'
import { ErrorBoundary } from '../shared/ui/ErrorBoundary'
import { FeedbackDialog } from '../features/feedback'
import { SiteFooter } from './SiteFooter'
import { SiteHeader } from './SiteHeader'
import { FaqPage } from '../pages/FaqPage'
import { HowItWorksPage } from '../pages/HowItWorksPage'
import { NotFoundPage, ServerErrorPage } from '../pages/StatusPage'
import { resetWizard, WizardApp } from '../features/wizard'

function ScrollToTop() {
  const { pathname } = useLocation()
  useEffect(() => {
    window.scrollTo(0, 0)
  }, [pathname])
  return null
}

/**
 * Leaving the wizard clears the form.
 *
 * The reset is tied to a ROUTE CHANGE, not to `WizardApp` unmounting: in Strict Mode
 * React mounts the component twice, and cleanup on unmount would wipe the state right
 * after the first mount — including a clip seeded from the URL.
 */
function ResetWizardOnLeave() {
  const { pathname } = useLocation()
  useEffect(() => {
    if (pathname !== '/') resetWizard()
  }, [pathname])
  return null
}

function AppShell() {
  return (
    <div className="app-shell">
      <ScrollToTop />
      <ResetWizardOnLeave />
      <SiteHeader />
      <div className="app-shell__body">
        <ErrorBoundary fallback={(reset) => <ServerErrorPage onRetry={reset} />}>
          <Outlet />
        </ErrorBoundary>
      </div>
      <SiteFooter />
      {/* Outside the error boundary: the popup must open from the 500 page too. */}
      <FeedbackDialog />
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<WizardApp />} />
        <Route path="how-it-works" element={<HowItWorksPage />} />
        <Route path="faq" element={<FaqPage />} />
        <Route path="500" element={<ServerErrorPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  )
}
