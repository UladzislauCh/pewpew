import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { checkVideoFile, getMediaLimitCopy, MEDIA_LIMITS } from '../model/mediaLimits'
import { useWizardStore } from '../store/wizardStore'
import '../../../shared/ui/Dropzone.css'

interface VideoDropzoneProps {
  onVideoSelected: (file: File) => void
}

export function VideoDropzone({ onVideoSelected }: VideoDropzoneProps) {
  const { t } = useTranslation()
  // The drag-over flag stays here: it's the state of ONE gesture over one element and
  // means nothing outside the component. The rejection reason does mean something:
  // the screen shows it, and there's one per screen.
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const rejectVideo = useWizardStore((s) => s.rejectVideo)
  const inputRef = useRef<HTMLInputElement>(null)
  const copy = getMediaLimitCopy().video

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      void checkVideoFile(file)
        .then((problem) => {
          if (problem) {
            rejectVideo(problem)
            return
          }
          onVideoSelected(file)
        })
        // The file couldn't be read — sniffing never happened. To the person this is
        // indistinguishable from “wrong file”, and there's no useful way to explain the difference.
        .catch(() => rejectVideo('type'))
    },
    [onVideoSelected, rejectVideo],
  )

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setIsDraggingOver(false)
      handleFile(event.dataTransfer.files[0])
    },
    [handleFile],
  )

  const openPicker = () => inputRef.current?.click()

  return (
    <div className="dropzone-block">
      {/*
       * The zone is a drop target and a big click target, but NOT a button: a real
       * button sits below it. The zone used to be `role="button"` with `tabIndex`, and
       * with a button inside that would be a button in a button — from the keyboard it
       * reads as one target when there are actually two.
       */}
      <div
        className={`dropzone ${isDraggingOver ? 'dropzone--active' : ''}`}
        onDragOver={(event) => {
          event.preventDefault()
          setIsDraggingOver(true)
        }}
        onDragLeave={() => setIsDraggingOver(false)}
        onDrop={handleDrop}
        onClick={openPicker}
      >
        <input
          ref={inputRef}
          type="file"
          accept={MEDIA_LIMITS.video.accept}
          className="dropzone__input"
          onChange={(event) => handleFile(event.target.files?.[0])}
        />
        <svg
          className="dropzone__icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
          <path d="M3.5 15v3a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-3" />
        </svg>
        <p className="dropzone__title">{t('dropzone.title')}</p>
        <p className="dropzone__hint">{t('dropzone.hint')}</p>
        {/* Limits BEFORE choosing, not in the error text after a rejection. Three short
            values can be read at a glance; the same three inside a sentence can't. */}
        <ul className="dropzone__limits">
          <li>{copy.formats}</li>
          <li>{t('dropzone.upTo', { value: copy.size })}</li>
          <li>{t('dropzone.upTo', { value: copy.duration })}</li>
        </ul>
      </div>

      <button type="button" className="dropzone__button" onClick={openPicker}>
        {t('dropzone.button')}
      </button>
    </div>
  )
}
