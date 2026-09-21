import { lazy, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, useTransition } from 'react'
import { useTranslation } from 'react-i18next'
import { getAudioContext } from '../../domain/audio/audioContext'
import { resetWizard, useWizardStore } from './store/wizardStore'
import { AnalyzingStep } from './steps/AnalyzingStep'
import { UploadStep } from './steps/UploadStep'
import { initialNav, isBusy, nav, remainingWait } from './model/navigation'
import { replacementProblemText, videoProblemText } from './model/problemCopy'
import { type WizardStep } from './model/types'
import {
  DEFAULT_SILENCE_THRESHOLD_RATIO,
} from '../../domain/audio/spliceDefaults'
import { DEFAULT_SOUND_ID, getLibrarySound, SOUND_LIBRARY } from '../../domain/audio/soundLibrary'
import { librarySoundKey } from './model/soundLabel'
import { assertAudioDuration, assertAudioLayout } from './model/mediaLimits'
import i18n from '../../shared/i18n'

const CheckShotsStep = lazy(() =>
  import('./steps/CheckShotsStep').then((m) => ({ default: m.CheckShotsStep })),
)
const EditShotsStep = lazy(() =>
  import('./steps/EditShotsStep').then((m) => ({ default: m.EditShotsStep })),
)
const AddSoundStep = lazy(() =>
  import('./steps/AddSoundStep').then((m) => ({ default: m.AddSoundStep })),
)
const PreviewStep = lazy(() =>
  import('./steps/PreviewStep').then((m) => ({ default: m.PreviewStep })),
)

function buildExportFileName(originalName: string): string {
  const withoutExt = originalName.replace(/\.[^./\\]+$/, '')
  return `${withoutExt || 'video'}-pewpew.mp4`
}

function formatRecordingName(): string {
  const time = new Date().toLocaleTimeString(i18n.language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  return i18n.t('wizard.recordingName', { time })
}

export function WizardApp() {
  // The language comes from the hook, not the module: the module-level `i18n` doesn't trigger
  // re-renders, and its `language` in dependencies would be a dead value.
  const { t, i18n: runtime } = useTranslation()
  const videoRef = useRef<HTMLVideoElement>(null)
  /**
   * Navigation is an explicit state machine in `wizard/navigation`. Rules and state live
   * there; here is only what can't live without React: the hold timer and the transition
   * that keeps the previous screen visible while the next one's chunk loads.
   */
  const [navState, dispatchNav] = useReducer(nav, 'upload', initialNav)
  const step = navState.step
  const [isStepPending, startStepTransition] = useTransition()

  /** Bumped to invalidate in-flight analysis / decode / export when the user cancels. */
  const workIdRef = useRef(0)
  const pendingSoundAdvanceRef = useRef(false)

  // Export state and its cancellation live in `store/exportSlice`. Here there's only reading
  // for render and the launch, because the wizard, not the store, knows “what to encode with”.
  const exportStatus = useWizardStore((s) => s.exportStatus)
  const exportProgress = useWizardStore((s) => s.exportProgress)
  const exportErrorRaw = useWizardStore((s) => s.exportError)
  const exportUrl = useWizardStore((s) => s.exportUrl)
  const startExport = useWizardStore((s) => s.startExport)
  const cancelExport = useWizardStore((s) => s.cancelExport)
  const resetExport = useWizardStore((s) => s.resetExport)
  // Translation happens here: the store holds the encoder's message as is.
  const exportError = exportErrorRaw ?? null

  const beginScreenBusy = useCallback((restart = false) => {
    dispatchNav({ type: 'busy', now: performance.now(), restart })
  }, [])

  /**
   * Cancel a scheduled transition, keeping the overlay. This used to be called
   * “releasing the lock” and required clearing the timer by hand; now it's a machine state.
   */
  const releaseNavLock = useCallback(() => {
    dispatchNav({ type: 'release', now: performance.now() })
  }, [])

  const endScreenBusy = useCallback(() => {
    dispatchNav({ type: 'done' })
  }, [])

  const cancelInFlightWork = useCallback(() => {
    workIdRef.current += 1
    pendingSoundAdvanceRef.current = false
    endScreenBusy()
    // Cancel, not reset: no reason to lose an already downloaded file when stepping back.
    cancelExport()
  }, [endScreenBusy, cancelExport])

  /** Navigate immediately without the min busy delay (used when cancelling). */
  const jumpToStep = useCallback(
    (next: WizardStep) => {
      cancelInFlightWork()
      dispatchNav({ type: 'jump', to: next })
    },
    [cancelInFlightWork],
  )

  const goToStep = useCallback((next: WizardStep) => {
    dispatchNav({ type: 'go', to: next, now: performance.now() })
  }, [])

  // Overlay hold: the machine says how much longer to wait; the timer lives here.
  // The step change goes through a transition — it keeps the previous screen while the next loads.
  useEffect(() => {
    if (navState.phase !== 'moving') return
    const timer = window.setTimeout(
      () => startStepTransition(() => dispatchNav({ type: 'commit' })),
      remainingWait(navState, performance.now()),
    )
    return () => window.clearTimeout(timer)
  }, [navState])

  // The new step's screen is built — drop the overlay.
  useEffect(() => {
    if (navState.phase !== 'settling' || isStepPending) return
    dispatchNav({ type: 'settled' })
  }, [navState.phase, isStepPending])

  // Warm the outro logo and sting while the user previews — hides load latency on download.
  useEffect(() => {
    if (step !== 'preview') return
    void import('./export/exportWithOutro').then(({ prefetchExportPipeline }) => {
      prefetchExportPipeline()
    })
  }, [step])

  // The clip and its media analysis live in `store/projectSlice`. The slice itself creates
  // and releases the file URL; the overlay and transitions stayed here — that's navigation.
  const videoFile = useWizardStore((s) => s.videoFile)
  const videoUrl = useWizardStore((s) => s.videoUrl)
  const mediaAnalysis = useWizardStore((s) => s.mediaAnalysis)
  const analysisProblem = useWizardStore((s) => s.analysisProblem)
  const foundShots = useWizardStore((s) => s.foundShots)
  const cancelDetection = useWizardStore((s) => s.cancelDetection)
  const isAnalyzing = useWizardStore((s) => s.isAnalyzing)
  const setVideoFile = useWizardStore((s) => s.setVideoFile)
  const analyzeProject = useWizardStore((s) => s.analyzeProject)
  const clearProject = useWizardStore((s) => s.clearProject)

  // Text by code lives in `model/problemCopy`: translations pull in i18n and `document`, and
  // the slice must run in Node with its tests.
  // LANGUAGE IN DEPENDENCIES. Texts are picked once per reason code, and the bridge returns the
  // translation as of the call. Without the language in dependencies, an error already on screen
  // stayed in the old language after switching — the whole screen changed, but not it.
  const analysisError = useMemo(() => {
    if (!analysisProblem) return null
    return videoProblemText(analysisProblem)
  }, [analysisProblem, runtime.language])

  /**
   * TEMPORARY. Model backend forced via the URL: `?backend=wasm` | `?backend=webgpu`.
   *
   * There is deliberately NO fallback. So `?backend=webgpu` also answers the main question
   * without any indicator: if the device can't do WebGPU, video analysis honestly fails
   * and the markers stay audio-based. A silent fallback would turn the check into a lie.
   */
  const forcedBackend = useMemo(() => {
    const value = new URLSearchParams(window.location.search).get('backend')
    return value === 'wasm' || value === 'webgpu' ? value : undefined
  }, [])

  // The heavy engine downloads in the background while the person picks a clip. Page entry
  // wasn't blocked by it before either — the worker is in a separate chunk; the point is that
  // the 36 MB don't all land on the first analysis while the user is already waiting. Only the
  // bytes are fetched, no session is created: someone who never analyses anything doesn't
  // lose memory. See `domain/detection/flash/warmup`.
  useEffect(() => {
    void import('../../domain/detection/flash/warmup').then((m) => m.warmFlashEngine())
  }, [])

  // Clip from the URL: `?clip=slug` seeds a corpus clip into the form right on open.
  //
  // Needed for manual marker-quality checks: otherwise fifty clips have to be dragged in
  // with the mouse one by one. The clips live in `fixtures/__ammo` — symlinks to `examples`
  // created by `npx tsx eval/ammoPrep.ts` — so this works only on the dev server
  // and never gets into the build.
  useEffect(() => {
    // DEVELOPMENT ONLY. `?clip=slug` seeds a corpus clip into the form so marker quality can
    // be checked across fifty clips without dragging them in by mouse. The clips are served
    // by a dev plugin from `fixtures/`; the build has neither this URL nor this branch:
    // `import.meta.env.DEV` is statically false, and the bundler strips it.
    if (!import.meta.env.DEV) return
    const clip = new URLSearchParams(window.location.search).get('clip')
    if (!clip) return
    let cancelled = false
    void fetch(`/__ammo/${encodeURIComponent(clip)}.mp4`)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`нет клипа ${clip}`))))
      .then((blob) => {
        if (!cancelled) setVideoFile(new File([blob], `${clip}.mp4`, { type: 'video/mp4' }))
      })
      .catch((error) => console.warn('Не удалось подставить клип из адреса:', error))
    return () => {
      cancelled = true
    }
  }, [])

  // The replacement sound lives in `store/replacementSlice`, along with decoding and limit
  // checks; the screen overlay and the move to the next step stayed here — that's navigation.
  const replacementAudio = useWizardStore((s) => s.replacementAudio)
  const replacementAudioBuffer = useWizardStore((s) => s.replacementBuffer)
  const replacementProblem = useWizardStore((s) => s.replacementError)
  const isDecodingAudio = useWizardStore((s) => s.isDecodingReplacement)
  const selectedLibraryId = useWizardStore((s) => s.selectedLibraryId)
  const silenceThresholdRatio = useWizardStore((s) => s.silenceThresholdRatio)
  const pickReplacement = useWizardStore((s) => s.pickReplacement)
  const decodeReplacement = useWizardStore((s) => s.decodeReplacement)
  const setSilenceThresholdRatio = useWizardStore((s) => s.setSilenceThreshold)
  const clearReplacement = useWizardStore((s) => s.clearReplacement)
  // The visible name of the current sound. A library sound is named by its id through the
  // translations, so the label follows the interface language; a recording or an uploaded
  // file keeps the name it came with.
  const currentSoundLabel = selectedLibraryId
    ? t(librarySoundKey(selectedLibraryId))
    : (replacementAudio?.name ?? null)

  // The store holds the reason CODE; the text comes from the same bridge as for the clip.
  const replacementDecodeError = useMemo(() => {
    if (!replacementProblem) return null
    return replacementProblemText(replacementProblem)
  }, [replacementProblem, runtime.language])
  // The waiting bar reached 100%. Lives here, not in the store: it's the state of ONE
  // animation on one screen and means nothing outside the wizard.
  const [progressFinished, setProgressFinished] = useState(false)
  // Stable reference: the waiting screen keeps it in its animation tick's dependencies,
  // and a new function on every render would restart the loop for nothing.
  const markProgressFinished = useCallback(() => setProgressFinished(true), [])
  useEffect(() => {
    setProgressFinished(false)
  }, [videoFile])

  /*
   * MARKER EDITING IS A STATE OF THE “CHECK” STEP, NOT A SEPARATE STEP.
   *
   * The step bar shows the same “2 · Check” on both screens: editing isn't a new milestone
   * but the “no” answer to the check question. The waiting screen works the same way here:
   * it's a state of the “Clip” step, not a fifth step.
   *
   * Reset on a new clip: editing of the previous one has nothing to do with it.
   */
  const [fixingShots, setFixingShots] = useState(false)
  useEffect(() => {
    setFixingShots(false)
  }, [videoFile])

  const [replacementTrimInfo, setReplacementTrimInfo] = useState<{
    totalDuration: number
    usedDuration: number
    trimmedLead: number
  } | null>(null)


  // Shot detection progress lives in `store/detectionSlice`. The pipeline itself is assembled
  // below, here: that's where the measured facts behind its design are.
  const onsetAnalysis = useWizardStore((s) => s.onsetAnalysis)
  const isDetecting = useWizardStore((s) => s.isDetecting)
  const isScoringMotion = useWizardStore((s) => s.isScanningVideo)
  const shotsReadyFor = useWizardStore((s) => s.shotsReadyFor)
  const slowBackend = useWizardStore((s) => s.slowBackend)
  const runDetection = useWizardStore((s) => s.runDetection)
  const clearDetection = useWizardStore((s) => s.clearDetection)
  // Markers live in the store: the editor and the track read and edit them, and they get here
  // only from detection. Their actions live in `store/shotsSlice`.
  const setShots = useWizardStore((s) => s.setShots)
  const clearShots = useWizardStore((s) => s.clearShots)
  // The wizard needs the markers themselves in exactly one place: audio splicing is recomputed
  // when the user edits them.
  const shots = useWizardStore((s) => s.shots)

  const [splicedAudioBuffer, setSplicedAudioBuffer] = useState<AudioBuffer | null>(null)


  const resetProject = useCallback(() => {
    workIdRef.current += 1
    pendingSoundAdvanceRef.current = false
    endScreenBusy()
    dispatchNav({ type: 'jump', to: 'upload' })
    clearProject()
    clearReplacement()
    setSilenceThresholdRatio(DEFAULT_SILENCE_THRESHOLD_RATIO)
    clearDetection()
    clearShots()
    setReplacementTrimInfo(null)
    setSplicedAudioBuffer(null)
    // New project — forget the previous file entirely, URL included.
    resetExport()
  }, [endScreenBusy, resetExport, clearShots])

  // Clip analysis. The analysis itself is in the slice; this only supplies the METHOD, because
  // mediabunny and `AudioContext` exist only in the browser. The overlay and releasing the
  // navigation lock stay here: that's about the screen, not the data.
  useEffect(() => {
    if (!videoFile) return
    releaseNavLock()
    beginScreenBusy(true)

    // Prefetch the next chunk while analysis runs.
    void import('./steps/EditShotsStep')

    void analyzeProject(async () => {
      const { analyzeMedia } = await import('../../domain/video/mediaAnalysis')
      return analyzeMedia(videoFile, getAudioContext())
    })
  }, [videoFile, analyzeProject, beginScreenBusy, releaseNavLock])

  // Analysis failed — drop the overlay: there's nothing to proceed with.
  useEffect(() => {
    if (!analysisProblem) return
    endScreenBusy()
  }, [analysisProblem, endScreenBusy])

  // The edit screen shows ONLY when everything is ready: both media analysis and shot detection.
  // The transition used to fire once media analysis alone was ready, and the person landed
  // on “check the markers” with a spinner instead of markers.
  //
  // One more condition: the waiting bar must run to the end. Work can finish at any
  // percentage — the estimate needn't be right — and without this delay the waiting screen
  // would vanish showing, say, 63%.
  useEffect(() => {
    if (isAnalyzing || analysisError || step !== 'upload') return
    if (!videoFile || !mediaAnalysis) return
    if (shotsReadyFor !== videoFile || !progressFinished) return
    goToStep('edit-shots')
  }, [
    isAnalyzing,
    videoFile,
    mediaAnalysis,
    analysisError,
    step,
    shotsReadyFor,
    progressFinished,
    goToStep,
  ])

  // Onset curve + shot detection — after PCM is available.
  //
  // Shots come from the convolutional detector (ShotNet), not from spectral flow. Spectral flow
  // answers "energy changed here", which tops out around 13% precision at full recall; the net
  // scores every frame with "a shot is here" and reaches 36% at 90% recall on the same clips.
  //
  // The onset curve is still computed: the editor draws it as the waveform backdrop, and it is
  // independent of which detector places the marks.
  //
  // Spectral flow stays as a fallback. The net needs a 72 KB weights file over the network, and
  // a failed fetch must degrade to the old behaviour rather than leave the user with no marks.
  useEffect(() => {
    if (!mediaAnalysis?.audioBuffer) {
      clearDetection()
      clearShots()
      return
    }
    const audioBuffer = mediaAnalysis.audioBuffer

    // The slice drives the detection lifecycle: it synchronously raises the “running” flag,
    // marks readiness for this file and discards stale runs.
    void runDetection(videoFile, async (report) => {
      const [{ computeOnsetCurve }, { detectShots }] = await Promise.all([
        import('../../domain/detection/onsetDetection'),
        import('../../domain/detection/shotDetection'),
      ])
      const onset = computeOnsetCurve(audioBuffer)
      report.onset(onset)

      try {
        const { detectShotsNet } = await import('../../domain/detection/shotNet/adapter')
        const { MOTION_PARAMS } = await import('../../domain/detection/motion/motionFeatures')
        // The candidate threshold comes from the motion model's parameters, not the default.
        // The adapter defaults to 0.5, while the model was trained on candidates at 0.3 — so it
        // was fed a distribution it had never seen, and some shots never reached the
        // second stage at all.
        // Audio candidates are needed by the COUNTER: on a real ammo counter the drops line up
        // with the sound; on a timer or scoreboard they don't. They don't produce the timings, but
        // the final labels get one rigid clip-wide shift towards them (`alignToAudio`).
        const { shots: netShots } = await detectShotsNet(audioBuffer, {
          threshold: MOTION_PARAMS.candidateThreshold,
        })

        // THERE IS NO PRELIMINARY COUNT HERE, and that was checked on a clip. The audio stage
        // yields CANDIDATES at threshold 0.3, not shots: on `ak47` that's 85 versus 20 in the
        // final answer. Showing 85 and then switching to 20 is worse than showing nothing:
        // the person watches the system “lose” two thirds of what it found.
        if (!videoFile) {
          setShots(netShots)
          return
        }

        report.scanningVideo(true)
        try {
          // ONE PASS OVER THE FRAMES, two readers on it. The flash model looks at every frame
          // of the clip, and the ammo counter is read from the same frames — a second pass
          // would cost another decode, and decoding is exactly the bottleneck.
          //
          // LADDER, per clip: the ammo counter if one is found, otherwise the flash. The
          // counter is dropped for the flash when most confident flashes have no counter
          // decrement next to them — that is a foreign row (scoreboard, player count).
          //
          // Audio does not produce the timings, but it does take part: `netShots` select the
          // counter slot (a real counter's decrements line up with the sound), and the final
          // labels get one rigid clip-wide shift to where the shot is heard (`alignToAudio`).
          //
          // The motion stage (`domain/detection/motion/detectWithMotion`) and audio-candidate
          // confirmation (`domain/detection/flash/scoreShotsByFlash`) stay in the code but are
          // not called from here.
          //
          // Measured on 50 clips: the combination gives F1 65.9 versus 51.9 for flash alone
          // and 51.6 for the counter alone. Single shots: 55 of 107 versus 37 and 30.
          const { detectByFlash } = await import('../../domain/detection/flash/detectByFlash')
          const found = await detectByFlash(videoFile, {
            audioShots: netShots,
            // TEMPORARY, for investigating slow runs on phones: `?backend=wasm`
            // or `?backend=webgpu` forces the backend. Works in the production build too —
            // that's the point, since it has to be checked on a phone, where there are no browser flags.
            backend: forcedBackend,
            signal: report.signal,
            onBackend: (backend) => {
              report.backend(backend)
            },
          })
          report.found(found.length)
          setShots(found)
        } catch (flashErr) {
          // Cancel isn't a failure: the pipeline was aborted on purpose, and no markers are needed.
          if (report.signal.aborted) return
          // The video stage failed TECHNICALLY (no model, no WebGPU or wasm, a broken
          // file) — hand out the audio markers: worse, but workable. This isn't a quality
          // fallback: on clips without a flash the markers will simply be audio-based.
          console.warn('Video stage unavailable, keeping audio-only marks:', flashErr)
          setShots(netShots)
        } finally {
          report.scanningVideo(false)
        }
      } catch (netErr) {
        console.warn('ShotNet unavailable, falling back to spectral flow:', netErr)
        setShots(detectShots(audioBuffer, onset))
      }
    }).catch((err: unknown) => {
      console.error('Onset / shot detection failed:', err)
      clearShots()
    })
  }, [mediaAnalysis, videoFile, runDetection, clearDetection, clearShots, setShots, forcedBackend])

  useEffect(() => {
    if (!replacementAudio) return

    // Auto-advance (recording or uploading your own file) keeps the overlay up until the preview.
    // A library pick stays on this screen — no overlay.
    if (pendingSoundAdvanceRef.current) beginScreenBusy(true)

    // The preview will need splicing — prefetch it while decoding runs.
    void import('./steps/PreviewStep')
    void import('../../domain/audio/spliceReplacementAudio')

    // Decoding itself and the limit checks live in the slice; this only supplies the METHOD
    // of decoding, because `AudioContext` exists only in the browser.
    void decodeReplacement(async () => {
      const { probeAudioFile } = await import('../../domain/video/mediaAnalysis')
      const probe = await probeAudioFile(replacementAudio.blob)
      if (probe.duration != null) assertAudioDuration(probe.duration)
      if (probe.sampleRate != null && probe.numberOfChannels != null) {
        assertAudioLayout(probe.sampleRate, probe.numberOfChannels)
      }
      const arrayBuffer = await replacementAudio.blob.arrayBuffer()
      return getAudioContext().decodeAudioData(arrayBuffer)
    })
  }, [replacementAudio, decodeReplacement, beginScreenBusy])

  // Decoding failed — drop the overlay and cancel auto-advance: there's nothing to proceed with.
  useEffect(() => {
    if (!replacementProblem) return
    pendingSoundAdvanceRef.current = false
    endScreenBusy()
  }, [replacementProblem, endScreenBusy])

  useEffect(() => {
    if (!pendingSoundAdvanceRef.current || !replacementAudioBuffer || replacementDecodeError) return
    if (isDecodingAudio) return
    pendingSoundAdvanceRef.current = false
    goToStep('preview')
  }, [replacementAudioBuffer, replacementDecodeError, isDecodingAudio, goToStep])


  const setReplacementFromBlob = useCallback(
    (blob: Blob, name: string, options?: { advance?: boolean; libraryId?: string | null }) => {
      pendingSoundAdvanceRef.current = options?.advance ?? true
      // The previous splice and file are invalid immediately: otherwise the download button
      // could finish or restart an export with the old sound.
      resetExport()
      setSplicedAudioBuffer(null)
      pickReplacement({ blob, name }, options?.libraryId ?? null)
    },
    [resetExport, pickReplacement],
  )

  /*
   * THE DEFAULT MEME GOES IN BY ITSELF, before the person has picked anything.
   *
   * The whole check step rests on this: by the time it starts, shots are already replaced,
   * and the first action is to listen, not to choose. An empty “pick a sound first, then
   * check” step would be redundant here: your own meme comes in the next step, and any
   * short one will do for checking whether the markers land.
   *
   * LOADING RUNS ALONGSIDE ANALYSIS, not after it: a file of a couple dozen kilobytes
   * gets decoded during the seconds of shot detection, and the splice is ready by the
   * check screen. Hence the last analysis phase — “putting the sound on the shots”.
   *
   * Seeded EXACTLY ONCE per clip: `seededFor` remembers the file it was already done for,
   * otherwise the person's choice would get overwritten back to Bonk.
   */
  const seededFor = useRef<File | null>(null)
  useEffect(() => {
    if (!videoFile || seededFor.current === videoFile) return
    // The person has already chosen (went back, changed the sound) — don't override.
    if (replacementAudio) return
    const sound = getLibrarySound(DEFAULT_SOUND_ID)
    if (!sound) return
    seededFor.current = videoFile

    let cancelled = false
    void fetch(sound.src)
      .then((response) => {
        if (!response.ok) throw new Error(`звук ${sound.id}: ${response.status}`)
        return response.blob()
      })
      .then((blob) => {
        if (cancelled) return
        const file = new File([blob], sound.fileName, { type: blob.type || 'audio/wav' })
        setReplacementFromBlob(file, sound.fileName, { advance: false, libraryId: sound.id })
      })
      .catch((err) => {
        // Don't show the failure: without the default meme the check screen simply has no
        // replacement sound, and the person can still pick their own in the next step.
        console.error('Мем по умолчанию не загрузился:', err)
        seededFor.current = null
      })

    return () => {
      cancelled = true
    }
  }, [videoFile, replacementAudio, setReplacementFromBlob])

  // Silence-trim bounds for the UI slider; mute window is max(2s, trimmed length) so short
  // replacement clips still cover long gunshot tails without a second control.
  useEffect(() => {
    if (!replacementAudioBuffer) {
      setReplacementTrimInfo(null)
      return
    }

    let cancelled = false
    const buffer = replacementAudioBuffer
    const threshold = silenceThresholdRatio

    void import('../../domain/audio/silenceTrim').then(({ findSilenceTrimBounds }) => {
      if (cancelled) return
      const channels: Float32Array[] = []
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        channels.push(buffer.getChannelData(ch))
      }
      const { startSample, endSample } = findSilenceTrimBounds(channels, threshold)
      const sampleRate = buffer.sampleRate
      setReplacementTrimInfo({
        totalDuration: buffer.duration,
        usedDuration: (endSample - startSample) / sampleRate,
        trimmedLead: startSample / sampleRate,
      })
    })

    return () => {
      cancelled = true
    }
  }, [replacementAudioBuffer, silenceThresholdRatio])

  // Audio splice for live preview / export — after shots + replacement exist
  useEffect(() => {
    if (!mediaAnalysis?.audioBuffer || !replacementAudioBuffer) {
      setSplicedAudioBuffer(null)
      return
    }

    let cancelled = false
    const sourceBuffer = mediaAnalysis.audioBuffer
    const replacement = replacementAudioBuffer
    const shotList = shots
    const threshold = silenceThresholdRatio

    void import('../../domain/audio/spliceReplacementAudio')
      .then(({ spliceReplacementAudio }) => {
        if (cancelled) return
        setSplicedAudioBuffer(
          spliceReplacementAudio(sourceBuffer, replacement, shotList, getAudioContext(), {
            silenceThresholdRatio: threshold,
          }),
        )
      })
      .catch((err) => {
        console.error('Audio splicing failed:', err)
        if (!cancelled) setSplicedAudioBuffer(null)
      })

    return () => {
      cancelled = true
    }
  }, [mediaAnalysis, replacementAudioBuffer, shots, silenceThresholdRatio])

  // The audio was remixed — the previous file no longer matches the clip. The slice itself
  // releases the URL; a separate effect for it is no longer needed.
  useEffect(() => {
    resetExport()
  }, [splicedAudioBuffer, resetExport])

  // Encoding: the wizard knows HOW to encode, the store knows WHAT STATE the process is in.
  // So a function is passed in, not data: the slice doesn't drag in mediabunny,
  // and it can be tested with a fake encoder.
  const handleExport = useCallback(async (): Promise<Blob | null> => {
    if (!videoFile || !splicedAudioBuffer || !mediaAnalysis) return null
    return startExport(async (onProgress) => {
      const { exportVideoWithBrandedOutro } = await import('./export/exportWithOutro')
      return exportVideoWithBrandedOutro(
        videoFile,
        splicedAudioBuffer,
        mediaAnalysis.duration,
        {
          width: mediaAnalysis.video?.width ?? 1280,
          height: mediaAnalysis.video?.height ?? 720,
          frameRate: mediaAnalysis.video?.frameRate ?? null,
        },
        onProgress,
      )
    })
  }, [videoFile, splicedAudioBuffer, mediaAnalysis, startExport])

  const confirmLeaveVideo = useCallback(() => {
    if (!videoFile) return true
    return window.confirm(t('wizard.confirmLeave'))
  }, [videoFile, t])

  const handleBackToUpload = useCallback(() => {
    if (!confirmLeaveVideo()) return
    resetProject()
  }, [confirmLeaveVideo, resetProject])

  const handlePreviewBack = useCallback(() => {
    resetExport()
    jumpToStep('add-sound')
  }, [jumpToStep, resetExport])

  const handlePreviewStartOver = useCallback(() => {
    if (!window.confirm(t('wizard.confirmStartOver'))) return
    resetProject()
  }, [resetProject, t])

  const handleAddSoundBack = useCallback(() => {
    jumpToStep('edit-shots')
  }, [jumpToStep])

  const wizardBusy = isBusy(navState) || isStepPending
  const previewBusy = wizardBusy || exportStatus === 'exporting'

  // Keep all steps in one tree so useTransition can leave the previous screen visible
  // (with the busy overlay) while the next lazy chunk loads — no layout jump to a separate loader.
  return (
    <Suspense fallback={null}>
      {step === 'upload' && videoFile && !analysisError ? (
        /*
         * The waiting screen is a state of the FIRST step, not a fifth step: a file is picked,
         * we haven't moved on yet, and the step bar honestly shows “1 · Clip”.
         */
        <AnalyzingStep
          fileName={videoFile.name}
          mediaAnalysis={mediaAnalysis}
          isAnalyzing={isAnalyzing}
          isDetecting={isDetecting || shotsReadyFor !== videoFile}
          foundShots={foundShots}
          onCancel={() => {
            cancelDetection()
            resetWizard()
            // Navigation may still be “busy” from when the file was picked: without this
            // the next transition silently won't fire.
            endScreenBusy()
          }}
          onFinished={markProgressFinished}
        />
      ) : step === 'upload' || !videoFile || !videoUrl ? (
        <UploadStep analysisError={analysisError} onVideoSelected={setVideoFile} />
      ) : step === 'edit-shots' && fixingShots ? (
        /*
         * Editing is a state of the same “Check” step, reached only via the answer
         * “no, fix it”. It can't be a separate step: the bar shows the same second step
         * on both screens.
         */
        <EditShotsStep
          videoUrl={videoUrl}
          videoRef={videoRef}
          mediaAnalysis={mediaAnalysis}
          onsetAnalysis={onsetAnalysis}
          isAnalyzing={isAnalyzing}
          analysisError={analysisError}
          splicedAudioBuffer={splicedAudioBuffer}
          busy={wizardBusy || isDetecting}
          onBack={() => setFixingShots(false)}
          onDone={() => {
            // Editing is done — go FORWARD, to picking a meme. The editing flag is cleared
            // along the way: otherwise going back from sound would land in the tools again,
            // not on the check where we came from.
            setFixingShots(false)
            void import('./steps/AddSoundStep')
            beginScreenBusy(true)
            goToStep('add-sound')
          }}
          isScoringMotion={isScoringMotion}
        />
      ) : step === 'edit-shots' ? (
        <CheckShotsStep
          videoUrl={videoUrl}
          videoRef={videoRef}
          mediaAnalysis={mediaAnalysis}
          onsetAnalysis={onsetAnalysis}
          isAnalyzing={isAnalyzing}
          analysisError={analysisError}
          splicedAudioBuffer={splicedAudioBuffer}
          soundName={currentSoundLabel}
          // While shot detection runs, the screen is covered by the regular overlay: nothing to listen to yet.
          busy={wizardBusy || isDetecting}
          onBack={handleBackToUpload}
          onAccept={() => {
            void import('./steps/AddSoundStep')
            beginScreenBusy(true)
            goToStep('add-sound')
          }}
          onFix={() => setFixingShots(true)}
          isScoringMotion={isScoringMotion}
          slowBackend={slowBackend}
        />
      ) : step === 'add-sound' ? (
        <AddSoundStep
          decodeError={replacementDecodeError}
          busy={wizardBusy}
          isDecoding={isDecodingAudio}
          onRecorded={(blob) => {
            setReplacementFromBlob(blob, formatRecordingName())
          }}
          onFileSelected={(file) => {
            setReplacementFromBlob(file, file.name)
          }}
          onLibraryPick={(soundId, file) => {
            const sound = SOUND_LIBRARY.find((entry) => entry.id === soundId)
            setReplacementFromBlob(file, sound?.fileName ?? file.name, {
              advance: false,
              libraryId: soundId,
            })
          }}
          selectedLibraryId={selectedLibraryId}
          currentSoundName={currentSoundLabel}
          onBack={handleAddSoundBack}
          hasAudio={Boolean(replacementAudioBuffer)}
          onContinue={() => {
            beginScreenBusy(true)
            goToStep('preview')
          }}
        />
      ) : (
        <PreviewStep
          videoUrl={videoUrl}
          videoRef={videoRef}
          mediaAnalysis={mediaAnalysis}
          onsetAnalysis={onsetAnalysis}
          isAnalyzing={isAnalyzing}
          analysisError={analysisError}
          trimInfo={replacementTrimInfo}
          silenceThresholdRatio={silenceThresholdRatio}
          onSilenceThresholdChange={setSilenceThresholdRatio}
          splicedAudioBuffer={splicedAudioBuffer}
          canExport={Boolean(splicedAudioBuffer && mediaAnalysis)}
          exportStatus={exportStatus}
          exportProgress={exportProgress}
          exportError={exportError}
          resultUrl={exportUrl}
          resultFileName={buildExportFileName(videoFile.name)}
          busy={previewBusy}
          onBack={handlePreviewBack}
          onExport={handleExport}
          onStartOver={handlePreviewStartOver}
        />
      )}
    </Suspense>
  )
}
