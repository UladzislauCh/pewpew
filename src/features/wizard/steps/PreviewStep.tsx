import { useCallback } from 'react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { triggerFileDownload } from '../components/ExportPanel'
import { ReplacementTrimControls } from '../components/ReplacementTrimControls'
import { VideoShotsEditor } from '../components/VideoShotsEditor'
import { useVideoReplacementAudio } from '../model/useVideoReplacementAudio'
import type { OnsetAnalysis } from '../../../domain/detection/onsetDetection'
import type { MediaAnalysis } from '../../../domain/video/mediaAnalysis'
import { getLibrarySound } from '../../../domain/audio/soundLibrary'
import { librarySoundKey } from '../model/soundLabel'
import { useWizardStore } from '../store/wizardStore'
import { WizardLayout } from '../WizardLayout'
import './PreviewStep.css'

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

interface ReplacementTrimInfo {
  totalDuration: number
  usedDuration: number
  trimmedLead: number
}

interface PreviewStepProps {
  videoUrl: string
  videoRef: RefObject<HTMLVideoElement | null>
  mediaAnalysis: MediaAnalysis | null
  onsetAnalysis: OnsetAnalysis | null
  isAnalyzing: boolean
  analysisError: string | null
  trimInfo: ReplacementTrimInfo | null
  silenceThresholdRatio: number
  onSilenceThresholdChange: (value: number) => void
  splicedAudioBuffer: AudioBuffer | null
  canExport: boolean
  exportStatus: 'idle' | 'exporting' | 'done' | 'error'
  exportProgress: number
  exportError: string | null
  resultUrl: string | null
  resultFileName: string
  busy?: boolean
  onBack: () => void
  onExport: () => Promise<Blob | null>
  onStartOver: () => void
}

export function PreviewStep({
  videoUrl,
  videoRef,
  mediaAnalysis,
  onsetAnalysis,
  isAnalyzing,
  analysisError,
  trimInfo,
  silenceThresholdRatio,
  onSilenceThresholdChange,
  splicedAudioBuffer,
  canExport,
  exportStatus,
  exportProgress,
  exportError,
  resultUrl,
  resultFileName,
  busy = false,
  onBack,
  onExport,
  onStartOver,
}: PreviewStepProps) {
  const { t } = useTranslation()
  useVideoReplacementAudio(videoRef, splicedAudioBuffer, true)

  // A three-number summary — a settled mockup item (docs/HANDOFF-design.md, “05 Done”);
  // this screen used to have none. Markers and sound are read straight from the store,
  // the same trick as the counter on the marking step — no prop drilling.
  const shotCount = useWizardStore((s) => s.shots.length)
  const selectedLibraryId = useWizardStore((s) => s.selectedLibraryId)
  const replacementAudio = useWizardStore((s) => s.replacementAudio)
  const librarySound = selectedLibraryId ? getLibrarySound(selectedLibraryId) : undefined
  const soundName = librarySound ? t(librarySoundKey(librarySound.id)) : (replacementAudio?.name ?? '—')

  const exporting = exportStatus === 'exporting'

  const handleDownload = useCallback(async () => {
    if (exportStatus === 'exporting') return

    // Already rendered — re-download only. Don't start a second encode if
    // `resultUrl` hasn't been minted yet (effect runs one tick after `done`).
    if (exportStatus === 'done') {
      if (resultUrl) triggerFileDownload(resultUrl, resultFileName)
      return
    }

    const blob = await onExport()
    if (!blob) return

    const url = URL.createObjectURL(blob)
    triggerFileDownload(url, resultFileName)
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }, [resultUrl, exportStatus, resultFileName, onExport])

  const downloadLabel = exporting
    ? t('wizard.preview.rendering', { percent: Math.round(exportProgress * 100) })
    : t('wizard.preview.download')

  return (
    <WizardLayout
      step="preview"
      title={t('wizard.preview.title')}
      hint={t('wizard.preview.hint')}
      onBack={onBack}
      backLabel={t('wizard.preview.back')}
      busy={busy}
      belowContent={
        <button type="button" className="wizard__text-action" onClick={onStartOver}>
          {t('wizard.preview.startOver')}
        </button>
      }
      primaryAction={{
        label: downloadLabel,
        onClick: () => void handleDownload(),
        disabled: !canExport || exporting || (busy && !exporting),
        progress: exporting ? exportProgress : undefined,
      }}
    >
      <dl className="preview__stat">
        <div>
          <dt>{t('wizard.preview.stat.shots')}</dt>
          <dd>{shotCount}</dd>
        </div>
        <div>
          <dt>{t('wizard.preview.stat.sound')}</dt>
          <dd className="preview__stat-sound">{soundName}</dd>
        </div>
        <div>
          <dt>{t('wizard.preview.stat.length')}</dt>
          <dd>{mediaAnalysis ? formatDuration(mediaAnalysis.duration) : '—'}</dd>
        </div>
      </dl>

      <VideoShotsEditor
        videoUrl={videoUrl}
        videoRef={videoRef}
        mediaAnalysis={mediaAnalysis}
        onsetAnalysis={onsetAnalysis}
        isAnalyzing={isAnalyzing}
        analysisError={analysisError}
        footer={
          trimInfo ? (
            <ReplacementTrimControls
              thresholdRatio={silenceThresholdRatio}
              onChange={onSilenceThresholdChange}
              durationSec={trimInfo.usedDuration}
            />
          ) : undefined
        }
      />

      {exportStatus === 'error' && exportError && <p className="card__error">{exportError}</p>}
    </WizardLayout>
  )
}
