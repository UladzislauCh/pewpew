import { useTranslation } from 'react-i18next'
import './MediaAnalysisPanel.css'

interface MediaAnalysisPanelProps {
  isLoading: boolean
  error: string | null
}

export function MediaAnalysisPanel({ isLoading, error }: MediaAnalysisPanelProps) {
  const { t } = useTranslation()

  if (isLoading) {
    return (
      <div className="analysis analysis--loading">
        <span className="analysis__spinner" aria-hidden="true" />
        <span>{t('analysis.loading')}</span>
      </div>
    )
  }

  if (error) {
    return (
      <div className="analysis analysis--error">
        <p>{error}</p>
      </div>
    )
  }

  return null
}
