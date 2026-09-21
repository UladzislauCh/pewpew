import { useTranslation } from 'react-i18next'
import { VideoDropzone } from '../components/VideoDropzone'
import { WizardLayout } from '../WizardLayout'

interface UploadStepProps {
  analysisError: string | null
  onVideoSelected: (file: File) => void
}

/*
 * THERE IS NO OVERLAY HERE ANYMORE. While analysis ran, the screen was covered by a grey
 * overlay with the `wizard.busy` line (“loading up…”) — that was the entire story of a thirty-second wait.
 * Waiting now has its own screen, and the overlay on the form stayed up after a
 * cancel: the work was over, but nothing was left to take it down.
 */
export function UploadStep({ analysisError, onVideoSelected }: UploadStepProps) {
  const { t } = useTranslation()
  return (
    <WizardLayout
      step="upload"
      title={t('wizard.upload.title')}
      hint={t('wizard.upload.hint')}
    >
      {/* No `wizard__panel` wrapper: in the mockup the zone sits right on the page background.
          A card around the zone added a second frame around the first — a frame inside a
          frame separates nothing and just takes space. */}
      <VideoDropzone onVideoSelected={onVideoSelected} />
      {/* role="alert": the rejection arrives asynchronously, after the person has already
          dropped the file. Without the role a screen reader won't announce it at all. */}
      {analysisError && (
        <p className="upload-error" role="alert">
          <svg className="upload-error__icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" />
            <path d="M10 6v5M10 13.6v.1" />
          </svg>
          {analysisError}
        </p>
      )}
    </WizardLayout>
  )
}
