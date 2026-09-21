import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { AudioRecorder } from './AudioRecorder'
import { AudioUploadButton } from './AudioUploadButton'
import { SOUND_LIBRARY, type LibrarySound } from '../../../domain/audio/soundLibrary'
import { librarySoundKey } from '../model/soundLabel'
import './AudioSourcePicker.css'

interface AudioSourcePickerProps {
  onRecorded: (blob: Blob) => void
  onFileSelected: (file: File) => void
  /** Called when the user picks a library sound. */
  onLibraryPick?: (sound: LibrarySound, file: File) => void
  selectedLibraryId?: string | null
  /** Mic / library load errors — shown under the white panel by the parent. */
  onError?: (message: string | null) => void
}

type Tab = 'library' | 'record' | 'upload'

function PlayIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <path d="M3 1.5v9l7-4.5z" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
      <rect x="1.5" y="1.5" width="9" height="9" rx="1" />
    </svg>
  )
}

/*
 * Tabs instead of three tiles, as in the mockup: “Arsenal” shows cards right in the tab,
 * not a separate full-screen view with its own back arrow. Clicking a card or its play
 * button both select the sound; the play button also plays it.
 */
export function AudioSourcePicker({
  onRecorded,
  onFileSelected,
  onLibraryPick,
  selectedLibraryId = null,
  onError,
}: AudioSourcePickerProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<Tab>('library')
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [durations, setDurations] = useState<Record<string, number>>({})
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Each sound's duration comes from metadata only, not the full file, so we don't pull
  // sixteen whole audio files just for a caption under a card.
  useEffect(() => {
    const probes = SOUND_LIBRARY.map((sound) => {
      const audio = new Audio()
      audio.preload = 'metadata'
      audio.addEventListener('loadedmetadata', () => {
        setDurations((prev) => ({ ...prev, [sound.id]: audio.duration }))
      })
      audio.src = sound.src
      return audio
    })
    return () => {
      probes.forEach((audio) => {
        audio.removeAttribute('src')
        audio.load()
      })
    }
  }, [])

  useEffect(() => {
    return () => {
      const audio = audioRef.current
      if (!audio) return
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audioRef.current = null
    }
  }, [])

  const stopPlayback = () => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
    audioRef.current = null
    setPlayingId(null)
  }

  const togglePlay = (sound: LibrarySound) => {
    if (playingId === sound.id) {
      stopPlayback()
      return
    }
    stopPlayback()
    const audio = new Audio(sound.src)
    audioRef.current = audio
    setPlayingId(sound.id)
    audio.addEventListener('ended', () => {
      if (audioRef.current === audio) {
        audioRef.current = null
        setPlayingId(null)
      }
    })
    void audio.play().catch(() => {
      if (audioRef.current === audio) {
        audioRef.current = null
        setPlayingId(null)
      }
    })
  }

  const selectSound = (sound: LibrarySound) => {
    onError?.(null)
    void fetch(sound.src)
      .then((response) => {
        if (!response.ok) {
          throw new Error(t('audioSource.libraryLoadFailedStatus', { status: response.status }))
        }
        return response.blob()
      })
      .then((blob) => {
        const file = new File([blob], sound.fileName, { type: blob.type || 'audio/wav' })
        if (onLibraryPick) onLibraryPick(sound, file)
        else onFileSelected(file)
      })
      .catch((err) => {
        console.error('Library sound fetch failed:', err)
        onError?.(t('audioSource.libraryLoadFailed'))
      })
  }

  const soundName = (sound: LibrarySound) => t(librarySoundKey(sound.id))

  const tabs: { id: Tab; label: string }[] = [
    { id: 'library', label: t('audioSource.tabs.library') },
    { id: 'record', label: t('audioSource.tabs.record') },
    { id: 'upload', label: t('audioSource.tabs.upload') },
  ]

  return (
    <div className="audio-source-picker">
      <div className="audio-source-picker__tabs" role="tablist" aria-label={t('audioSource.tabsAria')}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`audio-source-picker__tab${tab === item.id ? ' audio-source-picker__tab--on' : ''}`}
            onClick={() => {
              if (tab === 'record') stopPlayback()
              onError?.(null)
              setTab(item.id)
            }}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'library' && (
        <div
          className="audio-source-picker__grid"
          role="listbox"
          aria-label={t('library.listAria')}
        >
          {SOUND_LIBRARY.map((sound) => {
            const isSelected = selectedLibraryId === sound.id
            const isPlaying = playingId === sound.id
            const name = soundName(sound)
            const duration = durations[sound.id]
            return (
              <div
                key={sound.id}
                className={`audio-source-picker__snd${isSelected ? ' audio-source-picker__snd--on' : ''}`}
              >
                <button
                  type="button"
                  className="audio-source-picker__snd-play"
                  aria-label={
                    isPlaying ? t('library.stopAria', { name }) : t('library.playAria', { name })
                  }
                  aria-pressed={isPlaying}
                  onClick={() => {
                    selectSound(sound)
                    togglePlay(sound)
                  }}
                >
                  {isPlaying ? <StopIcon /> : <PlayIcon />}
                </button>
                <button
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className="audio-source-picker__snd-body"
                  onClick={() => selectSound(sound)}
                >
                  <span className="audio-source-picker__snd-name">{name}</span>
                  {duration !== undefined && (
                    <span className="audio-source-picker__snd-len">
                      {t('audioSource.soundLength', { seconds: duration.toFixed(1) })}
                    </span>
                  )}
                </button>
              </div>
            )
          })}
        </div>
      )}

      {tab === 'record' && (
        <div className="audio-source-picker__panel">
          <AudioRecorder
            onRecorded={(blob) => {
              onError?.(null)
              onRecorded(blob)
            }}
            onError={onError}
            variant="tile"
          />
        </div>
      )}

      {tab === 'upload' && (
        <div className="audio-source-picker__panel">
          <AudioUploadButton onFileSelected={onFileSelected} onError={onError} />
        </div>
      )}
    </div>
  )
}
