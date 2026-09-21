import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import '../shared/i18n'
import '../shared/ui/index.css'
import App from './App.tsx'
import { setupAnalytics } from './analytics'

// inject()

// Analytics is wired up BEFORE render, and only when VITE_GA_ID is set (ADR 0011).
setupAnalytics()

/*
 * BrowserRouter, not HashRouter — and that is a REQUIREMENT ON HOSTING, not just on code.
 *
 * Hash-free URLs get indexed by search engines and unfurl into messenger previews;
 * with `#/faq`, every page was the same document to the server. In exchange, the host must
 * serve `index.html` for any path that has no file: otherwise a direct visit or F5
 * on `/faq` hits the server's own 404, and the app never reaches the browser.
 *
 * Where it's configured: `try_files {path} /index.html` in Caddy on the production server.
 * When changing hosting, the rule must move too — and it MUST NOT be forgotten: locally
 * `vite preview` provides this fallback on its own, so the breakage only shows on real static hosting.
 */
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)