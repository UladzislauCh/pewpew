import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import i18n from '../../shared/i18n'
import { LabelerApp } from './LabelerApp'
import '../../shared/ui/index.css'
import './LabelerApp.css'

// The labeler's own strings are plain English, but the shared timeline (`OnsetCurveView`)
// translates its captions through i18next. Without an initialised instance it rendered raw
// keys such as `onset.detector`; pin English so the whole page speaks one language regardless
// of the language stored by the wizard (the preference itself is not overwritten).
void i18n.changeLanguage('en')

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <LabelerApp />
  </StrictMode>,
)
