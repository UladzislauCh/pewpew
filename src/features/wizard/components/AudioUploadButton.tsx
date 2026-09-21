import { useCallback, useRef, useState } from 'react'
import type { DragEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { getMediaLimitCopy, MEDIA_LIMITS, validateAudioFile } from '../model/mediaLimits'
import '../../../shared/ui/Dropzone.css'

interface AudioUploadButtonProps {
  onFileSelected: (file: File) => void
  onError?: (message: string | null) => void
}

/*
 * The same drop zone as for video (`Dropzone.css`, same `.dropzone` class),
 * only the text and limits are for audio. It used to be a lone button with no
 * file drop and a different style: bevelled-corner frame, caps, monospace —
 * not the same mockup as the video form, even though both are drop forms.
 */
export function AudioUploadButton({ onFileSelected, onError }: AudioUploadButtonProps) {
  const { t } = useTranslation()
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const audio = getMediaLimitCopy().audio

  const handleFile = useCallback(
    (file: File | undefined) => {
      if (!file) return
      void validateAudioFile(file)
        .then((limitError) => {
          if (limitError) {
            onError?.(limitError)
            return
          }
          onError?.(null)
          onFileSelected(file)
        })
        .catch(() => {
          onError?.(getMediaLimitCopy().audio.typeError)
        })
    },
    [onFileSelected, onError],
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
          accept={MEDIA_LIMITS.audio.accept}
          className="dropzone__input"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            handleFile(file)
          }}
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
        <p className="dropzone__title">{t('audioUpload.dropTitle')}</p>
        <p className="dropzone__hint">{t('dropzone.hint')}</p>
        <ul className="dropzone__limits">
          <li>{audio.formats}</li>
          <li>{t('dropzone.upTo', { value: audio.size })}</li>
          <li>{t('dropzone.upTo', { value: audio.duration })}</li>
        </ul>
      </div>

      <button type="button" className="dropzone__button" onClick={openPicker}>
        {t('dropzone.button')}
      </button>
    </div>
  )
}
