import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OnsetCurveView } from '../../shared/ui/OnsetCurveView'
import { getAudioContext } from '../../domain/audio/audioContext'
import { toMono, type AudioLike } from '../../domain/audio/audioTypes'
import { categoryRecall, scoreDetections } from '../../domain/detection/detectionMetrics'
import { sortShotsByTime, type ClipLabels, type LabeledShot, type ShotSource } from '../../domain/detection/labels'
import { analyzeMedia } from '../../domain/video/mediaAnalysis'
import { computeOnsetCurve, type OnsetAnalysis } from '../../domain/detection/onsetDetection'
import { detectShots, type DetectedShot } from '../../domain/detection/shotDetection'
import { audioBufferToFloat32WavBlob } from '../../domain/audio/wavEncoder'
import { WEAPON_IDS, weaponLabel } from '../../domain/detection/weapons'
import { fetchClipFile, fetchClips, fetchLabels, saveAudioCache, saveLabels, type ClipEntry } from './api'
import { ScoreBoard } from './ScoreBoard'
import { ShotTable } from './ShotTable'

/** Two markers closer than this are certainly the same shot double-entered. */
const DUPLICATE_EPSILON_SECONDS = 0.005
// 0.1x — to tell shots inside a burst apart: at 100 ms between them they merge into one
// sound at normal speed, while slowed down they spread out to a second.
const PLAYBACK_RATES = [0.1, 0.25, 0.5, 1]

/**
 * Arrow-key seek step, seconds. Alt gives a fine step: with snapping gone, all precision
 * is on the human, and 20 ms is a bit coarse for that given the metric's 50 ms tolerance.
 */
const SEEK_STEP_SECONDS = { fine: 0.005, normal: 0.02, coarse: 0.5 }

const COLOR_OWN = '#6fd08c'
const COLOR_ENEMY = '#60a5fa'
const COLOR_HARD = '#ff5d5d'
const COLOR_SELECTED = '#f8fafc'

/** Runtime-only id so React rows / drag follow the same shot across re-sorts. Never written to disk. */
type EditableShot = LabeledShot & { id: string }

let nextShotId = 1
function createShotId(): string {
  return `s${nextShotId++}`
}

function withShotIds(shots: readonly LabeledShot[]): EditableShot[] {
  return shots.map((shot) => ({ ...shot, id: createShotId() }))
}

function toPersistedShots(shots: readonly EditableShot[]): LabeledShot[] {
  return sortShotsByTime(
    shots.map(({ time, source, weapon, hard, note }) => ({
      time,
      source,
      weapon,
      hard,
      ...(note ? { note } : {}),
    })),
  )
}

interface LoadedClip {
  entry: ClipEntry
  url: string
  /**
   * `AudioLike`, not `AudioBuffer`: that is what media parsing returns, and only channels,
   * sample rate and duration are read from here — exactly what this type has.
   */
  audioBuffer: AudioLike
  mono: Float32Array
  onset: OnsetAnalysis
  autoShots: DetectedShot[]
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable
}

/** Most frequent weapon among own shots — used to restore the clip-level default on load. */
function inferPrimaryWeapon(shots: readonly LabeledShot[]): string | null {
  const counts = new Map<string, number>()
  for (const shot of shots) {
    if (shot.source !== 'own' || !shot.weapon) continue
    counts.set(shot.weapon, (counts.get(shot.weapon) ?? 0) + 1)
  }
  let best: string | null = null
  let bestCount = 0
  for (const [id, count] of counts) {
    if (count > bestCount) {
      best = id
      bestCount = count
    }
  }
  return best
}

function applyWeaponToOwnShots(shots: readonly EditableShot[], weapon: string | null): EditableShot[] {
  return shots.map((shot) => (shot.source === 'own' ? { ...shot, weapon } : shot))
}

export function LabelerApp() {
  const videoRef = useRef<HTMLVideoElement>(null)

  const [clips, setClips] = useState<ClipEntry[]>([])
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [clip, setClip] = useState<LoadedClip | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [shots, setShots] = useState<EditableShot[]>([])
  const [notes, setNotes] = useState('')
  const [complete, setComplete] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set())
  const [isDirty, setIsDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [focusTime, setFocusTime] = useState<number | null>(null)
  const [playbackRate, setPlaybackRate] = useState(1)
  const [showDetectorLane, setShowDetectorLane] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(!selectedSlug)

  // Sticky source: most markers in a clip share the same shooter. Own-shot weapon comes from
  // `primaryWeapon` instead — one clip-level default that can still be overridden per row.
  const [lastSource, setLastSource] = useState<ShotSource>('own')
  const [primaryWeapon, setPrimaryWeapon] = useState<string | null>(null)

  useEffect(() => {
    fetchClips()
      .then((clips) => {
        setClips(clips)
        if (clips.length > 0 && !selectedSlug) {
          setSelectedSlug(clips[0].slug)
          setSidebarOpen(false)
        }
      })
      .catch((err: unknown) => setError(String(err)))
  }, [])

  useEffect(() => {
    if (!selectedSlug) {
      setClip(null)
      return
    }
    const entry = clips.find((candidate) => candidate.slug === selectedSlug)
    if (!entry) return

    let cancelled = false
    let objectUrl: string | null = null
    setIsLoading(true)
    setError(null)
    setClip(null)
    setShots([])
    setSelectedIndex(null)
    setIsDirty(false)
    setSaveState('idle')
    setPrimaryWeapon(null)
    setComplete(false)
    setNotes('')
    setLastSource('own')

    void (async () => {
      try {
        const file = await fetchClipFile(entry)
        const analysis = await analyzeMedia(file, getAudioContext())
        if (!analysis.audioBuffer) throw new Error('The audio track cannot be decoded')
        const onset = computeOnsetCurve(analysis.audioBuffer)
        const autoShots = detectShots(analysis.audioBuffer, onset)
        const existing = await fetchLabels(entry.slug)
        if (cancelled) return

        objectUrl = URL.createObjectURL(file)
        setClip({
          entry,
          url: objectUrl,
          audioBuffer: analysis.audioBuffer,
          mono: toMono(analysis.audioBuffer),
          onset,
          autoShots,
        })
        const loadedShots = existing ? withShotIds(sortShotsByTime(existing.shots)) : []
        setShots(loadedShots)
        setNotes(existing?.notes ?? '')
        setComplete(existing?.complete ?? false)
        setPrimaryWeapon(inferPrimaryWeapon(loadedShots))
        setLastSource('own')
      } catch (err) {
        if (!cancelled) setError(String(err))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    })()

    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [selectedSlug, clips])

  useEffect(() => {
    const video = videoRef.current
    if (video) video.playbackRate = playbackRate
  }, [playbackRate, clip])

  useEffect(() => {
    if (!isDirty) return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [isDirty])

  const mutateShots = useCallback((update: (previous: EditableShot[]) => EditableShot[]) => {
    setShots(update)
    setIsDirty(true)
    setSaveState('idle')
  }, [])

  const addShotAt = useCallback(
    (rawTime: number) => {
      const time = rawTime
      const source = lastSource
      const id = createShotId()
      let nextSelected: number | null = null
      mutateShots((previous) => {
        if (previous.some((shot) => Math.abs(shot.time - time) < DUPLICATE_EPSILON_SECONDS)) {
          return previous
        }
        const next = sortShotsByTime([
          ...previous,
          {
            id,
            time,
            source,
            weapon: source === 'own' ? primaryWeapon : null,
            hard: false,
          },
        ])
        nextSelected = next.findIndex((shot) => shot.id === id)
        return next
      })
      if (nextSelected !== null && nextSelected >= 0) setSelectedIndex(nextSelected)
    },
    [mutateShots, lastSource, primaryWeapon],
  )

  const setPrimaryWeaponAndApply = useCallback(
    (weapon: string | null) => {
      if (complete) return
      setPrimaryWeapon(weapon)
      mutateShots((previous) => applyWeaponToOwnShots(previous, weapon))
    },
    [complete, mutateShots],
  )

  const removeShotAt = useCallback(
    (index: number) => {
      mutateShots((previous) => previous.filter((_, i) => i !== index))
      setSelectedIndex(null)
    },
    [mutateShots],
  )

  /** Fallback for the delete shortcut when nothing is selected: drop the marker under the playhead. */
  const removeShotNearPlayhead = useCallback(() => {
    const video = videoRef.current
    if (!video || shots.length === 0) return

    let nearestIndex = -1
    let nearestDistance = Infinity
    shots.forEach((shot, index) => {
      const distance = Math.abs(shot.time - video.currentTime)
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    })
    if (nearestIndex !== -1 && nearestDistance <= 0.15) removeShotAt(nearestIndex)
  }, [shots, removeShotAt])

  const clearShots = useCallback(() => {
    if (shots.length === 0) return
    if (!window.confirm(`Delete all marks (${shots.length})?`)) return
    mutateShots(() => [])
    setSelectedIndex(null)
  }, [shots, mutateShots])

  const moveShot = useCallback(
    (index: number, time: number) => {
      mutateShots((previous) => previous.map((shot, i) => (i === index ? { ...shot, time } : shot)))
      setSelectedIndex(index)
    },
    [mutateShots],
  )

  // The label lands exactly where the human put it. There is deliberately no snapping.
  //
  // The label used to jump to the loudest sample within 25 ms. On a single shot this hardly
  // matters, but in a burst it hurts: the loudest sample is not the attack but the body of
  // the transient, and within the window it is often the tail of the PREVIOUS shot, if that
  // one was louder. The label drifted onto the neighbouring shot, and the denser the fire,
  // the more often — that is, exactly where labelling is hardest anyway.
  //
  // Precision does not suffer: the spread of manual labelling is about 18 ms against the
  // metric's 50 ms tolerance, a twofold margin. But the systematic offset the heuristic
  // introduced went into the reference and from there into the network's training targets.
  const finishMove = useCallback(
    (index: number) => {
      let movedId: string | null = null
      let nextSelected: number | null = null
      mutateShots((previous) => {
        const target = previous[index]
        if (!target) return previous
        movedId = target.id
        const sorted = sortShotsByTime(previous)
        nextSelected = sorted.findIndex((shot) => shot.id === movedId)
        return sorted
      })
      if (nextSelected !== null && nextSelected >= 0) setSelectedIndex(nextSelected)
    },
    [mutateShots],
  )

  const updateShot = useCallback(
    (index: number, patch: Partial<LabeledShot>) => {
      mutateShots((previous) =>
        previous.map((shot, i) => {
          if (i !== index) return shot
          const next = { ...shot, ...patch }
          // Switching to own inherits the clip default unless the patch already sets a weapon.
          if (patch.source === 'own' && patch.weapon === undefined) {
            next.weapon = primaryWeapon
          }
          return next
        }),
      )
      if (patch.source) setLastSource(patch.source)
    },
    [mutateShots, primaryWeapon],
  )

  const seedFromDetector = useCallback(() => {
    if (!clip) return
    mutateShots(() =>
      sortShotsByTime(
        clip.autoShots.map((shot) => ({
          id: createShotId(),
          time: shot.time,
          source: lastSource,
          weapon: lastSource === 'own' ? primaryWeapon : null,
          hard: false,
        })),
      ),
    )
  }, [clip, mutateShots, lastSource, primaryWeapon])

  const selectShot = useCallback(
    (index: number | null, multiSelect: boolean = false) => {
      if (multiSelect && index !== null) {
        const next = new Set(selectedIndices)
        if (next.has(index)) {
          next.delete(index)
        } else {
          next.add(index)
        }
        setSelectedIndices(next)
      } else {
        setSelectedIndices(new Set())
        setSelectedIndex(index)
        if (index === null || !clip) return
        const shot = shots[index]
        if (!shot) return
        const video = videoRef.current
        if (video) video.currentTime = shot.time
        setFocusTime(shot.time)
      }
    },
    [clip, shots, selectedIndices],
  )

  const bulkUpdateShots = useCallback(
    (patch: Partial<LabeledShot>) => {
      if (selectedIndices.size === 0) return
      mutateShots((previous) =>
        previous.map((shot, i) => (selectedIndices.has(i) ? { ...shot, ...patch } : shot)),
      )
      setLastSource(patch.source ?? lastSource)
    },
    [selectedIndices, mutateShots, lastSource],
  )

  const stepSelection = useCallback(
    (delta: number) => {
      if (shots.length === 0) return
      const current = selectedIndex ?? (delta > 0 ? -1 : shots.length)
      const next = Math.min(shots.length - 1, Math.max(0, current + delta))
      selectShot(next)
    },
    [shots, selectedIndex, selectShot],
  )

  const save = useCallback(async () => {
    if (!clip) return
    setSaveState('saving')
    try {
      const payload: ClipLabels = {
        version: 1,
        clip: clip.entry.file,
        slug: clip.entry.slug,
        duration: clip.audioBuffer.duration,
        sampleRate: clip.audioBuffer.sampleRate,
        numberOfChannels: clip.audioBuffer.numberOfChannels,
        labeledAt: new Date().toISOString(),
        ...(notes ? { notes } : {}),
        complete,
        shots: toPersistedShots(shots),
      }
      await saveLabels(payload)
      await saveAudioCache(clip.entry.slug, audioBufferToFloat32WavBlob(clip.audioBuffer))
      setIsDirty(false)
      setSaveState('saved')
      setClips(await fetchClips())
    } catch (err) {
      setError(String(err))
      setSaveState('error')
    }
  }, [clip, notes, complete, shots])

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return
      const video = videoRef.current

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
        return
      }
      // Alt is let through only for arrows — that is the fine seek step. Everything else
      // with modifiers still goes to the system.
      const isArrow = event.key === 'ArrowLeft' || event.key === 'ArrowRight'
      if (event.metaKey || event.ctrlKey || (event.altKey && !isArrow)) return

      const step = event.altKey
        ? SEEK_STEP_SECONDS.fine
        : event.shiftKey
          ? SEEK_STEP_SECONDS.coarse
          : SEEK_STEP_SECONDS.normal

      switch (event.key) {
        case ' ':
          event.preventDefault()
          if (video) void (video.paused ? video.play() : video.pause())
          break
        case 'ArrowLeft':
          event.preventDefault()
          if (video) video.currentTime = Math.max(0, video.currentTime - step)
          break
        case 'ArrowRight':
          event.preventDefault()
          if (video) video.currentTime += step
          break
        case 'a':
        case 'A':
        case 'ф':
        case 'Ф':
          event.preventDefault()
          if (video) addShotAt(video.currentTime)
          break
        case 'x':
        case 'X':
        case 'Delete':
        case 'Backspace':
        case 'ч':
        case 'Ч':
          event.preventDefault()
          if (selectedIndex !== null) removeShotAt(selectedIndex)
          else removeShotNearPlayhead()
          break
        case 'j':
        case 'J':
        case 'о':
        case 'О':
          event.preventDefault()
          stepSelection(-1)
          break
        case 'k':
        case 'K':
        case 'л':
        case 'Л':
          event.preventDefault()
          stepSelection(1)
          break
        case 'e':
        case 'E':
        case 'у':
        case 'У':
          event.preventDefault()
          if (selectedIndex !== null) {
            updateShot(selectedIndex, { source: shots[selectedIndex].source === 'own' ? 'enemy' : 'own' })
          }
          break
        case 'h':
        case 'H':
        case 'р':
        case 'Р':
          event.preventDefault()
          if (selectedIndex !== null) updateShot(selectedIndex, { hard: !shots[selectedIndex].hard })
          break
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [addShotAt, removeShotAt, removeShotNearPlayhead, stepSelection, updateShot, save, selectedIndex, shots])

  const sortedShots = useMemo(() => sortShotsByTime(shots), [shots])

  // The lane takes raw samples, not a buffer (see `OnsetCurveView`). `useMemo` keeps the
  // reference stable across renders so the canvas is not redrawn for nothing.
  const clipSamples = useMemo(() => clip?.audioBuffer.getChannelData(0) ?? null, [clip])

  const shotColors = useMemo(
    () =>
      shots.map((shot, index) => {
        if (index === selectedIndex) return COLOR_SELECTED
        if (shot.hard) return COLOR_HARD
        return shot.source === 'own' ? COLOR_OWN : COLOR_ENEMY
      }),
    [shots, selectedIndex],
  )

  // Assistant metric: own shots are targets; enemy hits count as FP (user must delete them).
  const score = useMemo(() => {
    if (!clip) return null
    const targets = sortedShots.filter((shot) => shot.source === 'own')
    const reference = targets.map((shot) => shot.time)
    const predicted = clip.autoShots.map((shot) => shot.time)
    const at50 = scoreDetections(reference, predicted, 0.05)
    return {
      at50,
      at25: scoreDetections(reference, predicted, 0.025),
      ignoredTotal: sortedShots.filter((shot) => shot.source !== 'own').length,
      categories: [categoryRecall('hard', at50.match, reference.length, (i) => targets[i].hard)],
    }
  }, [clip, sortedShots])

  const labeledCount = clips.filter((entry) => entry.complete).length

  return (
    <div className="labeler">
      <div
        className={`labeler__backdrop${sidebarOpen ? ' labeler__backdrop--visible' : ''}`}
        onClick={() => setSidebarOpen(false)}
      />
      <aside className={`labeler__sidebar${sidebarOpen ? ' labeler__sidebar--open' : ''}`}>
        <div className="labeler__sidebar-header">
          <div className="labeler__brand">
            <h1>Shot labeling</h1>
            <p className="labeler__hint">
              {labeledCount} of {clips.length} clips marked as done
            </p>
          </div>
          <button
            type="button"
            className="labeler__sidebar-close"
            onClick={() => setSidebarOpen(false)}
            title="Close sidebar"
          >
            ✕
          </button>
        </div>
        <ul className="labeler__clips">
          {clips.map((entry) => (
            <li key={entry.slug}>
              <button
                type="button"
                className={`labeler__clip${entry.slug === selectedSlug ? ' labeler__clip--active' : ''}`}
                onClick={() => {
                  if (isDirty && !window.confirm('You have unsaved changes. Switch clip anyway?')) return
                  setSelectedSlug(entry.slug)
                  setSidebarOpen(false)
                }}
              >
                <span className="labeler__clip-name">{entry.file}</span>
                <span className="labeler__clip-meta">
                  {entry.complete ? '✓ done' : entry.hasLabels ? 'draft' : 'unlabeled'}
                  {entry.hasLabels ? ` · ${entry.shotCount}` : ''}
                  {entry.hasCache ? ' · wav' : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="labeler__shortcuts">
          <h3>Hotkeys</h3>
          <dl>
            <div><dt>Space</dt><dd>play / pause</dd></div>
            <div><dt>A</dt><dd>mark at the playhead</dd></div>
            <div><dt>J / K</dt><dd>previous / next mark</dd></div>
            <div><dt>X</dt><dd>delete the selected mark (or the one nearest the playhead)</dd></div>
            <div><dt>E</dt><dd>own ↔ enemy</dd></div>
            <div><dt>H</dt><dd>toggle “hard”</dd></div>
            <div><dt>← →</dt><dd>±20 ms (±500 ms with Shift)</dd></div>
            <div><dt>⌘S</dt><dd>save</dd></div>
          </dl>
        </div>
      </aside>

      <main className="labeler__main">
        {error && <p className="labeler__error">{error}</p>}
        {!selectedSlug && !error && <p className="labeler__empty">Pick a clip on the left to start labeling.</p>}
        {isLoading && <p className="labeler__empty">Decoding and analyzing the clip…</p>}

        {clip && (
          <>
            <header className="labeler__toolbar">
              <button
                type="button"
                className="labeler__chip"
                onClick={() => setSidebarOpen(true)}
                title="Open the clip list"
              >
                ☰ Clips
              </button>
              <div className="labeler__toolbar-controls">
                <div className="labeler__rates">
                  <span className="labeler__label">Speed</span>
                  {PLAYBACK_RATES.map((rate) => (
                    <button
                      key={rate}
                      type="button"
                      className={`labeler__chip${rate === playbackRate ? ' labeler__chip--active' : ''}`}
                      onClick={() => setPlaybackRate(rate)}
                    >
                      {rate}×
                    </button>
                  ))}
                </div>
                <button type="button" className="labeler__chip" onClick={seedFromDetector}>
                  Fill from auto-detection ({clip.autoShots.length})
                </button>
                <button
                  type="button"
                  className={`labeler__chip${showDetectorLane ? ' labeler__chip--active' : ''}`}
                  onClick={() => setShowDetectorLane((previous) => !previous)}
                >
                  {showDetectorLane ? 'Hide' : 'Show'} detector lane
                </button>
                <button type="button" className="labeler__chip" onClick={clearShots} disabled={shots.length === 0}>
                  Clear marks
                </button>
                <label className={`labeler__field${complete ? ' labeler__field--disabled' : ''}`}>
                  <span className="labeler__label">Primary weapon</span>
                  <select
                    value={primaryWeapon ?? ''}
                    disabled={complete}
                    onChange={(event) => setPrimaryWeaponAndApply(event.target.value || null)}
                  >
                    <option value="">unknown</option>
                    {WEAPON_IDS.map((id) => (
                      <option key={id} value={id}>
                        {weaponLabel(id)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="labeler__checkbox">
                  <input type="checkbox" checked={complete} onChange={(event) => {
                    setComplete(event.target.checked)
                    setIsDirty(true)
                  }} />
                  Clip fully labeled
                </label>
                <button
                  type="button"
                  className="labeler__save"
                  onClick={() => void save()}
                  disabled={saveState === 'saving' || !isDirty}
                >
                  {saveState === 'saving' ? 'Saving…' : isDirty ? 'Save' : 'Saved'}
                </button>
              </div>
            </header>

            <div className="labeler__content">
              <div className="labeler__curves">
                <video ref={videoRef} src={clip.url} className="labeler__video" controls preload="auto" />
              </div>

              <div className="labeler__sidebar-table">
                {selectedIndices.size > 0 && (
                  <div className="labeler__bulk-edit">
                    <p className="labeler__bulk-label">Edit {selectedIndices.size} selected:</p>
                    <div className="labeler__bulk-controls">
                      <label className="labeler__bulk-field">
                        <span className="labeler__label">Source</span>
                        <select
                          value=""
                          onChange={(event) => {
                            if (event.target.value) {
                              bulkUpdateShots({ source: event.target.value as LabeledShot['source'] })
                              event.target.value = ''
                            }
                          }}
                        >
                          <option value="">choose…</option>
                          <option value="own">own</option>
                          <option value="enemy">enemy</option>
                        </select>
                      </label>
                      <label className="labeler__bulk-field">
                        <span className="labeler__label">Weapon</span>
                        <select
                          value=""
                          onChange={(event) => {
                            if (event.target.value !== '') {
                              bulkUpdateShots({ weapon: event.target.value || null })
                              event.target.value = ''
                            }
                          }}
                        >
                          <option value="">choose…</option>
                          <option value="">unknown</option>
                          {WEAPON_IDS.map((id) => (
                            <option key={id} value={id}>
                              {weaponLabel(id)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="labeler__bulk-checkbox">
                        <input
                          type="checkbox"
                          onChange={(event) => {
                            bulkUpdateShots({ hard: event.target.checked })
                          }}
                        />
                        Mark as hard
                      </label>
                      <button
                        type="button"
                        className="labeler__bulk-deselect"
                        onClick={() => setSelectedIndices(new Set())}
                      >
                        Clear selection
                      </button>
                    </div>
                  </div>
                )}

                <ShotTable
                  shots={shots}
                  selectedIndex={selectedIndex}
                  selectedIndices={selectedIndices}
                  onSelect={selectShot}
                  onUpdate={updateShot}
                  onRemove={removeShotAt}
                />
              </div>
            </div>

            {clipSamples && (
              <OnsetCurveView
                samples={clipSamples}
                sampleRate={clip.audioBuffer.sampleRate}
                duration={clip.audioBuffer.duration}
                frameTimes={clip.onset.frameTimes}
                onsetStrength={clip.onset.onsetStrength}
                spectralFlux={clip.onset.spectralFlux}
                highFrequencyRise={clip.onset.highFrequencyRise}
                videoRef={videoRef}
                shots={shots}
                shotColors={shotColors}
                referenceShots={showDetectorLane ? clip.autoShots : undefined}
                focusTime={focusTime}
                onAddShot={addShotAt}
                onRemoveShot={removeShotAt}
                onMoveShot={moveShot}
                onMoveShotEnd={finishMove}
              />
            )}

            {score && <ScoreBoard score={score} />}

            <p className="labeler__hint">
              Label all gunfire: own shots with <kbd>A</kbd>, then <kbd>E</kbd> flips a mark to enemy. Until the clip is
              marked as done, the primary weapon is applied to all own shots; any mark's weapon can be
              changed in the table.
            </p>
            <p className="labeler__hint">
              The short orange ticks at the top are the audio detector (the “detector” lane). Only the coloured
              label marks are editable — double-click adds and removes them.
            </p>

            <label className="labeler__notes">
              <span className="labeler__label">Clip notes (noise, music, spectators)</span>
              <textarea
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value)
                  setIsDirty(true)
                }}
                rows={2}
              />
            </label>
          </>
        )}
      </main>
    </div>
  )
}
