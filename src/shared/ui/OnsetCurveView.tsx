import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import type { MouseEvent, PointerEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import './OnsetCurveView.css'

/** The visible time range, in seconds. Zooming/panning only changes this — never the data. */
export interface CurveView {
  start: number
  end: number
}

/**
 * The track KNOWS NOTHING about media analysis or detection.
 *
 * Its input is plain numbers — samples, sample rate, duration and ready-made curves — not
 * `AudioLike` with `OnsetAnalysis`. That keeps the component a pure renderer: the wizard and
 * the labelling tool call it the same way, and neither has to bend its data into the other's
 * shapes. It was also the only thing keeping it out of `shared/ui`.
 */
interface OnsetCurveViewProps {
  /** Samples of one channel. Memoize: a new reference redraws the canvas. */
  samples: Float32Array
  sampleRate: number
  /** Clip length in seconds — also the full span of the track. */
  duration: number
  /** Time of each curve point, in seconds. */
  frameTimes: Float32Array
  /** Onset strength, 0..1 — what peaks are picked from. The blue layer in the product. */
  onsetStrength: Float32Array
  /** Auxiliary labelling-tool curves; not drawn with `visualProfile="shots-first"`. */
  spectralFlux?: Float32Array
  highFrequencyRise?: Float32Array
  videoRef: RefObject<HTMLVideoElement | null>
  shots?: readonly { time: number }[]
  /** Per-shot marker colors, parallel to `shots`. Memoize to avoid needless canvas redraws. */
  shotColors?: readonly string[]
  /**
   * Read-only markers drawn in a separate lane above the editable ones — used by the labeling tool
   * to show what the detector currently finds while a human annotates the ground truth.
   */
  referenceShots?: readonly { time: number }[]
  /** When this changes, the view scrolls to keep the given time visible. */
  focusTime?: number | null
  /**
   * Width of the window the view snaps to when jumping to a marker, in seconds.
   *
   * Without it a jump only pans the window, keeping the old zoom — and on the overview
   * a three-shot burst spans six pixels, with nothing to aim at. With a three-second window
   * the same burst stretches to about fifty, and editing becomes possible. So the zoom
   * is applied AUTOMATICALLY rather than left to the wheel.
   */
  focusZoomSeconds?: number | null
  /**
   * The track as a MAP, not a tool: you can look and click to seek,
   * but not edit.
   *
   * Needed by the check screen: markers aren't edited there, the result is listened to,
   * and a toolbar on the track would only distract from that. Disables selection,
   * double-click, dragging, wheel zoom, the play button and zoom reset — that screen
   * has its own transport, under the track.
   */
  readOnly?: boolean
  onAddShot: (time: number) => void
  onRemoveShot: (index: number) => void
  /** Called continuously while a marker is being dragged, with its live index and new time. */
  onMoveShot: (index: number, time: number) => void
  /**
   * Called once a drag gesture ends for the given index, so that shot can be snapped and the list
   * re-sorted. Only the dragged marker should be mutated — re-snapping every shot pulls neighbors
   * onto the same peak on dense fire.
   */
  onMoveShotEnd: (index: number) => void
  /** Product UI: faint onset curves, bold shot markers. Labeler keeps `default`. */
  visualProfile?: 'default' | 'shots-first'
  /** Renders flush inside a parent media block (no outer canvas border/radius). */
  embedded?: boolean
  /**
   * Marker selection and keyboard editing: click selects, arrows move, Del removes.
   *
   * OFF BY DEFAULT, because the same view is used by the labelling tool, which binds its
   * own keys to the same arrows — two handlers would move the marker twice.
   */
  selectable?: boolean
}

/**
 * Arrow-key step, in seconds.
 *
 * Twenty milliseconds — the same as in the labelling tool, and not by chance: manual labels
 * scatter by about 18 ms, so a step finer than one's own placement error isn't needed.
 * There's deliberately no second, coarse step: a marker is placed by ear, not by counting.
 */
const NUDGE_SECONDS = 0.02

/** How long the track window glides when jumping to a marker, in milliseconds. */
const FOCUS_ANIM_MS = 260

/** A colour token (#hex or rgb(...)) plus our own alpha — for canvas, which can't read var(). */
function mixWithOpacity(token: string, alpha: number): string {
  const value = token.trim()
  if (value.startsWith('#')) {
    const hex = value.slice(1)
    const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex
    const r = parseInt(full.slice(0, 2), 16)
    const g = parseInt(full.slice(2, 4), 16)
    const b = parseInt(full.slice(4, 6), 16)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const nums = value.match(/[\d.]+/g)
  if (nums && nums.length >= 3) return `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, ${alpha})`
  return value
}

const CANVAS_HEIGHT = 110
/** The product track is shorter than the labelling tool's: the mockup gives the wave less room. */
const PRODUCT_CANVAS_HEIGHT = 85
/** How close (in pixels) a click/drag must land to an existing marker to hit it rather than adding a new one. */
const MARKER_HIT_RADIUS_PX = 8
/** Below this the view would show fewer samples than pixels, which stops being informative. */
const MIN_VIEW_SECONDS = 0.02
/** Pointer travel (px) beyond which a press is treated as a pan gesture rather than a click. */
const PAN_THRESHOLD_PX = 3
/** Same idea for markers: a plain click / first half of a double-click must not nudge a neighbor. */
const MARKER_DRAG_THRESHOLD_PX = 4

const DEFAULT_SHOT_COLOR = '#f97316'
const SHOTS_FIRST_SHOT_COLOR = '#fb923c'
const REFERENCE_COLOR = 'rgba(249, 115, 22, 0.75)'
/** Height of the read-only band at the top that holds `referenceShots`. */
const REFERENCE_LANE_HEIGHT = 14

function clampView(view: CurveView, duration: number): CurveView {
  const span = Math.min(Math.max(view.end - view.start, MIN_VIEW_SECONDS), duration)
  let start = Math.max(0, Math.min(view.start, duration - span))
  if (!Number.isFinite(start)) start = 0
  return { start, end: start + span }
}

export function OnsetCurveView({
  samples,
  sampleRate,
  duration,
  frameTimes,
  onsetStrength,
  spectralFlux,
  highFrequencyRise,
  videoRef,
  shots = [],
  shotColors,
  referenceShots,
  focusTime = null,
  focusZoomSeconds = null,
  readOnly = false,
  onAddShot,
  onRemoveShot,
  onMoveShot,
  onMoveShotEnd,
  visualProfile = 'default',
  embedded = false,
  selectable = false,
}: OnsetCurveViewProps) {
  const { t, i18n } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const baseCanvasRef = useRef<HTMLCanvasElement>(null)
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)
  const widthRef = useRef(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [selectedTime, setSelectedTime] = useState<number | null>(null)
  /** Index of the marker currently being dragged, or null when idle / below the move threshold. */
  const draggingIndexRef = useRef<number | null>(null)
  /** Press on a marker that has not yet traveled far enough to count as a drag. */
  const pendingMarkerRef = useRef<{ index: number; clientX: number } | null>(null)
  const dragMovedRef = useRef(false)
  const panOriginRef = useRef<{ clientX: number; viewStart: number } | null>(null)
  /** Suppress the click/dblclick that follows a real marker drag. */
  const suppressClickRef = useRef(false)

  const [view, setView] = useState<CurveView>({ start: 0, end: duration })

  // A new clip (or a re-decode) resets the viewport to the whole timeline.
  useEffect(() => {
    setView({ start: 0, end: duration })
  }, [duration])

  const viewRef = useRef(view)
  viewRef.current = view

  const isZoomed = view.end - view.start < duration - 1e-6

  /*
   * A jump to a marker GLIDES rather than snaps.
   *
   * Instantly swapping the overview for a three-second window changed the whole picture in
   * one frame: different wave, different markers, different ruler — and it was unclear what
   * had even happened. A quarter second of motion ties “before” and “after” into one
   * movement, and the person sees WHERE they were taken.
   *
   * With `focusZoomSeconds` the window settles at that width around the marker; without it,
   * it only pans if the marker went off the edge.
   */
  const focusAnimRef = useRef<number | null>(null)
  const cancelFocusAnim = () => {
    if (focusAnimRef.current === null) return
    cancelAnimationFrame(focusAnimRef.current)
    focusAnimRef.current = null
  }

  useEffect(() => {
    if (focusTime === null || !Number.isFinite(focusTime)) return
    const from = viewRef.current
    const target = (() => {
      if (focusZoomSeconds !== null && focusZoomSeconds > 0) {
        const span = Math.min(focusZoomSeconds, duration)
        return clampView({ start: focusTime - span / 2, end: focusTime + span / 2 }, duration)
      }
      const span = from.end - from.start
      if (focusTime >= from.start && focusTime <= from.end) return from
      return clampView({ start: focusTime - span / 2, end: focusTime + span / 2 }, duration)
    })()

    const moved = Math.abs(target.start - from.start) + Math.abs(target.end - from.end)
    if (moved < 1e-3) return

    cancelFocusAnim()
    // Respect the system setting: the glide is decoration; the jump itself matters more than showing it.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      setView(target)
      return
    }

    const started = performance.now()
    const step = () => {
      const k = Math.min(1, (performance.now() - started) / FOCUS_ANIM_MS)
      // Ease-out: the motion is noticeable at the start and doesn't jerk at the end.
      const eased = 1 - (1 - k) ** 3
      setView({
        start: from.start + (target.start - from.start) * eased,
        end: from.end + (target.end - from.end) * eased,
      })
      focusAnimRef.current = k < 1 ? requestAnimationFrame(step) : null
    }
    focusAnimRef.current = requestAnimationFrame(step)
    return cancelFocusAnim
  }, [focusTime, focusZoomSeconds, duration])

  // Draw the (static) waveform + onset curves whenever the data, viewport or container size changes.
  useEffect(() => {
    const container = containerRef.current
    const canvas = baseCanvasRef.current
    if (!container || !canvas) return

    // The product is shorter than the labelling tool — the mockup gives the wave less room, see PRODUCT_CANVAS_HEIGHT.
    const canvasHeight = embedded ? PRODUCT_CANVAS_HEIGHT : CANVAS_HEIGHT

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const width = container.clientWidth
      if (width === 0 || duration <= 0) return
      widthRef.current = width

      canvas.width = width * dpr
      canvas.height = canvasHeight * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${canvasHeight}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, canvasHeight)

      // Canvas doesn't understand var(...) — colours come from computed tokens rather than
      // hard-coded literals, otherwise a palette change in CSS would never reach here.
      const tokens = getComputedStyle(container)
      const waveClipColor = mixWithOpacity(tokens.getPropertyValue('--border-strong'), 0.5)
      const waveNetColor = mixWithOpacity(tokens.getPropertyValue('--info'), 0.38)

      const viewSpan = view.end - view.start
      const xOf = (time: number) => ((time - view.start) / viewSpan) * width

      const channel = samples
      const firstSample = Math.max(0, Math.floor(view.start * sampleRate))
      const lastSample = Math.min(channel.length, Math.ceil(view.end * sampleRate))
      const samplesPerPixel = Math.max(1, Math.floor((lastSample - firstSample) / width))

      if (visualProfile === 'shots-first') {
        /*
         * TWO FILLED LAYERS, as in the mockup, not three thin lines as before. Grey is
         * the clip's whole audio: where anything is happening at all. Blue is onset strength,
         * the very quantity peaks are picked from: where the system heard a shot.
         * The product has no third curve (`highFrequencyRise` on its own) — it was
         * visible on screen but labelled and explained nothing.
         *
         * Both layers are DELIBERATELY coarse: they're for orientation, not aiming, and
         * aiming is done by ear anyway.
         */

        // Grey is the mirrored amplitude envelope: the upper peak contour left to right,
        // then the lower contour back, as a single closed path for filling.
        const mid = canvasHeight / 2
        const tops: number[] = []
        const bottoms: number[] = []
        for (let x = 0; x < width; x++) {
          let min = 1
          let max = -1
          const start = firstSample + x * samplesPerPixel
          const end = Math.min(lastSample, start + samplesPerPixel)
          if (start >= lastSample) {
            tops.push(mid)
            bottoms.push(mid)
            continue
          }
          for (let i = start; i < end; i++) {
            const value = channel[i]
            if (value < min) min = value
            if (value > max) max = value
          }
          const amp = Math.max(Math.abs(min), Math.abs(max))
          tops.push(mid - amp * mid)
          bottoms.push(mid + amp * mid)
        }
        ctx.fillStyle = waveClipColor
        ctx.beginPath()
        ctx.moveTo(0, tops[0])
        for (let x = 1; x < width; x++) ctx.lineTo(x, tops[x])
        for (let x = width - 1; x >= 0; x--) ctx.lineTo(x, bottoms[x])
        ctx.closePath()
        ctx.fill()

        // Blue is onset strength from the bottom edge: not a mirage of symmetry but an honest
        // bar of “how much hit energy is here” — taller means more confident.
        ctx.fillStyle = waveNetColor
        ctx.beginPath()
        ctx.moveTo(0, canvasHeight)
        let lastX = 0
        for (let i = 0; i < onsetStrength.length; i++) {
          const time = frameTimes[i]
          if (time < view.start) continue
          if (time > view.end) break
          const x = xOf(time)
          const y = canvasHeight - onsetStrength[i] * canvasHeight
          ctx.lineTo(x, y)
          lastX = x
        }
        ctx.lineTo(lastX, canvasHeight)
        ctx.closePath()
        ctx.fill()
      } else {
        // Labelling tool: three separate thin lines, unchanged — its own state,
        // its own needs, not touched here.
        ctx.strokeStyle = 'rgba(199, 202, 209, 0.35)'
        ctx.lineWidth = 1
        ctx.beginPath()
        for (let x = 0; x < width; x++) {
          let min = 1
          let max = -1
          const start = firstSample + x * samplesPerPixel
          const end = Math.min(lastSample, start + samplesPerPixel)
          if (start >= lastSample) break
          for (let i = start; i < end; i++) {
            const value = channel[i]
            if (value < min) min = value
            if (value > max) max = value
          }
          const yMin = canvasHeight / 2 - min * (canvasHeight / 2)
          const yMax = canvasHeight / 2 - max * (canvasHeight / 2)
          ctx.moveTo(x, yMin)
          ctx.lineTo(x, yMax)
        }
        ctx.stroke()

        const drawCurve = (values: Float32Array, color: string, lineWidth: number) => {
          ctx.strokeStyle = color
          ctx.lineWidth = lineWidth
          ctx.beginPath()
          let started = false
          for (let i = 0; i < values.length; i++) {
            const time = frameTimes[i]
            if (time < view.start) continue
            if (time > view.end) break
            const x = xOf(time)
            const y = canvasHeight - values[i] * canvasHeight
            if (!started) {
              ctx.moveTo(x, y)
              started = true
            } else {
              ctx.lineTo(x, y)
            }
          }
          ctx.stroke()
        }

        if (spectralFlux) drawCurve(spectralFlux, 'rgba(96, 165, 250, 0.7)', 1)
        if (highFrequencyRise) drawCurve(highFrequencyRise, 'rgba(216, 128, 255, 0.1)', 1)
        drawCurve(onsetStrength, '#fb923c', 2)
      }

      // Read-only reference markers live in a captioned band across the top.
      if (referenceShots?.length) {
        ctx.fillStyle = 'rgba(255, 138, 61, 0.07)'
        ctx.fillRect(0, 0, width, REFERENCE_LANE_HEIGHT)

        ctx.strokeStyle = REFERENCE_COLOR
        ctx.lineWidth = 1
        ctx.beginPath()
        for (const marker of referenceShots) {
          if (marker.time < view.start || marker.time > view.end) continue
          const x = xOf(marker.time)
          ctx.moveTo(x, 2)
          ctx.lineTo(x, REFERENCE_LANE_HEIGHT - 2)
        }
        ctx.stroke()

        ctx.fillStyle = 'rgba(255, 138, 61, 0.65)'
        ctx.font = '9px ui-monospace, Consolas, monospace'
        ctx.textBaseline = 'middle'
        ctx.fillText(t('onset.detector'), 6, REFERENCE_LANE_HEIGHT / 2)
      }

      const markerTop = referenceShots?.length ? REFERENCE_LANE_HEIGHT : 0

      if (visualProfile === 'shots-first') {
        /*
         * MARKER: a dashed full-height line with a dot AT THE BOTTOM — as it was at the very
         * start, before that session's series of edits. A dot on top was tried — it stuck out
         * past the line at any size; at the bottom the same dot sits flush with the track's
         * lower edge and doesn't protrude.
         *
         * The selected marker is white with an orange glow — a canvas shadow instead of
         * box-shadow, which a canvas doesn't have.
         *
         * THIN LINE AND SMALL DOT: in a dense spray markers are a few pixels apart, and the
         * thick version merged into one orange mush — you couldn't tell where one shot
         * ended and the next began.
         */
        shots.forEach((shot) => {
          if (shot.time < view.start || shot.time > view.end) return
          const chosen = selectable && selectedTime !== null && shot.time === selectedTime
          const color = chosen ? '#f2f4f8' : SHOTS_FIRST_SHOT_COLOR
          const x = xOf(shot.time)

          if (chosen) {
            ctx.shadowColor = 'rgba(249, 115, 22, 0.55)'
            ctx.shadowBlur = 10
          }
          // The dot is centred on its own centre, and the line goes exactly to it — not below,
          // otherwise the stroke pokes out under the dot like a tail.
          const markerCenterY = canvasHeight - 6
          ctx.lineWidth = 1.5
          ctx.setLineDash([3, 3])
          ctx.strokeStyle = color
          ctx.beginPath()
          ctx.moveTo(x, markerTop)
          ctx.lineTo(x, markerCenterY)
          ctx.stroke()
          // The outline is inset within the same radius (not on top of it), so the dot doesn't
          // grow from the outline itself: it takes space from the fill. Solid, not dashed —
          // otherwise the marker line's `setLineDash` leaks onto the ring.
          const outerRadius = (chosen ? 4 : 3) + 0.5
          const ringWidth = 1
          ctx.fillStyle = color
          ctx.beginPath()
          ctx.arc(x, markerCenterY, outerRadius - ringWidth / 2, 0, Math.PI * 2)
          ctx.fill()
          ctx.lineWidth = ringWidth
          ctx.setLineDash([])
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
          ctx.stroke()
          ctx.shadowBlur = 0
        })
        ctx.setLineDash([])
      } else {
        // Labelling tool: dashed, dot at the bottom, colour by confidence — unchanged.
        const markerLineWidth = 1
        const markerRadius = 4
        ctx.lineWidth = markerLineWidth
        ctx.setLineDash([3, 3])
        shots.forEach((shot, index) => {
          if (shot.time < view.start || shot.time > view.end) return
          const color = shotColors?.[index] ?? DEFAULT_SHOT_COLOR
          ctx.strokeStyle = color
          ctx.fillStyle = color
          const x = xOf(shot.time)
          ctx.beginPath()
          ctx.moveTo(x, markerTop)
          ctx.lineTo(x, canvasHeight)
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(x, canvasHeight - 7, markerRadius, 0, Math.PI * 2)
          ctx.fill()
        })
        ctx.setLineDash([])
      }
    }

    draw()
    const resizeObserver = new ResizeObserver(draw)
    resizeObserver.observe(container)
    return () => resizeObserver.disconnect()
  }, [
    samples,
    sampleRate,
    frameTimes,
    onsetStrength,
    spectralFlux,
    highFrequencyRise,
    embedded,
    shots,
    shotColors,
    referenceShots,
    view,
    duration,
    visualProfile,
    selectable,
    selectedTime,
    t,
    i18n.language,
  ])

  // Continuously draw a running playhead in sync with the actual <video> currentTime.
  useEffect(() => {
    const canvas = overlayCanvasRef.current
    if (!canvas) return

    const dpr = window.devicePixelRatio || 1
    const canvasHeight = embedded ? PRODUCT_CANVAS_HEIGHT : CANVAS_HEIGHT
    let rafId: number

    const drawPlayhead = () => {
      rafId = requestAnimationFrame(drawPlayhead)

      const video = videoRef.current
      const width = widthRef.current
      if (!video || width === 0 || duration <= 0) return

      canvas.width = width * dpr
      canvas.height = canvasHeight * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${canvasHeight}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, width, canvasHeight)

      const current = viewRef.current
      const fraction = (video.currentTime - current.start) / (current.end - current.start)
      if (fraction < 0 || fraction > 1) return
      const x = fraction * width

      ctx.strokeStyle = '#f5f6f8'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, canvasHeight)
      ctx.stroke()

      ctx.fillStyle = '#f5f6f8'
      ctx.beginPath()
      ctx.moveTo(x - 5, 0)
      ctx.lineTo(x + 5, 0)
      ctx.lineTo(x, 8)
      ctx.closePath()
      ctx.fill()
    }

    rafId = requestAnimationFrame(drawPlayhead)
    return () => cancelAnimationFrame(rafId)
  }, [duration, videoRef, embedded])

  // Keep the play/pause button in sync, including when playback is controlled elsewhere
  // (e.g. the video element's own native controls).
  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const handlePlay = () => setIsPlaying(true)
    const handlePause = () => setIsPlaying(false)
    video.addEventListener('play', handlePlay)
    video.addEventListener('pause', handlePause)
    video.addEventListener('ended', handlePause)
    setIsPlaying(!video.paused)
    return () => {
      video.removeEventListener('play', handlePlay)
      video.removeEventListener('pause', handlePause)
      video.removeEventListener('ended', handlePause)
    }
  }, [videoRef])

  // Wheel zoom anchored at the cursor. Registered natively because React's synthetic wheel
  // listener is passive, which forbids preventDefault and would scroll the page instead.
  useEffect(() => {
    const container = containerRef.current
    if (!container || duration <= 0 || readOnly) return

    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      // The wheel cancels a gliding jump to a marker: otherwise the window has two owners
      // and jitters between where it's scrolled and where the animation is heading.
      cancelFocusAnim()
      const rect = container.getBoundingClientRect()
      if (rect.width === 0) return
      const anchorFraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))

      setView((current) => {
        const span = current.end - current.start
        const anchorTime = current.start + anchorFraction * span
        const scale = Math.exp(event.deltaY * 0.002)
        const nextSpan = Math.min(Math.max(span * scale, MIN_VIEW_SECONDS), duration)
        return clampView(
          { start: anchorTime - anchorFraction * nextSpan, end: anchorTime + (1 - anchorFraction) * nextSpan },
          duration,
        )
      })
    }

    container.addEventListener('wheel', handleWheel, { passive: false })
    return () => container.removeEventListener('wheel', handleWheel)
  }, [duration, readOnly])

  const timeFromEvent = (event: { clientX: number }): number | null => {
    const container = containerRef.current
    if (!container || duration <= 0) return null
    const rect = container.getBoundingClientRect()
    if (rect.width === 0) return null
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    return view.start + fraction * (view.end - view.start)
  }

  /** Pixel hit-radius converted to seconds at the container's current on-screen width. */
  const pixelToleranceSeconds = (radiusPx: number): number => {
    const container = containerRef.current
    if (!container || duration <= 0) return 0
    const width = container.getBoundingClientRect().width
    if (width === 0) return 0
    return (radiusPx / width) * (view.end - view.start)
  }

  const findNearestShotIndex = (time: number, toleranceSeconds: number): number => {
    let nearestIndex = -1
    let nearestDistance = Infinity
    shots.forEach((shot, index) => {
      const distance = Math.abs(shot.time - time)
      if (distance <= toleranceSeconds && distance < nearestDistance) {
        nearestDistance = distance
        nearestIndex = index
      }
    })
    return nearestIndex
  }

  const handleSeek = (event: MouseEvent<HTMLDivElement>) => {
    // A click that immediately follows a drag or pan gesture shouldn't also seek the video.
    if (suppressClickRef.current || dragMovedRef.current) {
      suppressClickRef.current = false
      dragMovedRef.current = false
      return
    }
    const video = videoRef.current
    const time = timeFromEvent(event)
    if (!video || time === null) return
    video.currentTime = time
  }

  const handleToggleShot = (event: MouseEvent<HTMLDivElement>) => {
    if (readOnly) return
    // Double-click after a drag would otherwise remove/add a shot on top of the move.
    if (suppressClickRef.current || dragMovedRef.current) {
      suppressClickRef.current = false
      dragMovedRef.current = false
      return
    }
    const time = timeFromEvent(event)
    if (time === null) return
    const nearestIndex = findNearestShotIndex(time, pixelToleranceSeconds(MARKER_HIT_RADIUS_PX))
    if (nearestIndex !== -1) {
      onRemoveShot(nearestIndex)
      setSelectedTime(null)
    } else {
      onAddShot(time)
      setSelectedTime(time)
    }
  }

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // In map mode there's no dragging or panning: only click-to-seek remains,
    // and that lives in `handleSeek` and doesn't need the pointer.
    if (readOnly) return
    const time = timeFromEvent(event)
    if (time === null) return
    // Same as with the wheel: the hand outranks a gliding jump.
    cancelFocusAnim()
    dragMovedRef.current = false
    suppressClickRef.current = false
    draggingIndexRef.current = null
    pendingMarkerRef.current = null

    const nearestIndex = findNearestShotIndex(time, pixelToleranceSeconds(MARKER_HIT_RADIUS_PX))
    if (nearestIndex !== -1) {
      // Clicking a marker SELECTS it: from then on the arrows move it. Focus goes here too,
      // otherwise nobody listens for the keys, and a global handler would steal the arrows
      // from the whole page.
      if (selectable) {
        setSelectedTime(shots[nearestIndex]?.time ?? null)
        event.currentTarget.focus()
      }
      // Do not move yet — wait for a real drag distance so double-clicks don't nudge neighbors.
      pendingMarkerRef.current = { index: nearestIndex, clientX: event.clientX }
      event.currentTarget.setPointerCapture(event.pointerId)
      return
    }

    // Nothing under the cursor — selection is cleared. Otherwise the arrows would keep moving
    // a marker the person is no longer looking at: they clicked elsewhere and expect a seek.
    if (selectable) setSelectedTime(null)

    // Empty space: start a potential pan. It only becomes one once the pointer actually travels,
    // so a plain click still seeks.
    panOriginRef.current = { clientX: event.clientX, viewStart: view.start }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    const time = timeFromEvent(event)
    if (time === null || !container) return

    const pending = pendingMarkerRef.current
    if (pending && draggingIndexRef.current === null) {
      const deltaPx = event.clientX - pending.clientX
      if (Math.abs(deltaPx) < MARKER_DRAG_THRESHOLD_PX) return
      draggingIndexRef.current = pending.index
      pendingMarkerRef.current = null
      dragMovedRef.current = true
      suppressClickRef.current = true
      onMoveShot(draggingIndexRef.current, time)
      return
    }

    if (draggingIndexRef.current !== null) {
      dragMovedRef.current = true
      suppressClickRef.current = true
      onMoveShot(draggingIndexRef.current, time)
      return
    }

    const panOrigin = panOriginRef.current
    if (panOrigin) {
      const rect = container.getBoundingClientRect()
      const deltaPx = event.clientX - panOrigin.clientX
      if (!dragMovedRef.current && Math.abs(deltaPx) < PAN_THRESHOLD_PX) return
      dragMovedRef.current = true
      suppressClickRef.current = true
      const span = view.end - view.start
      const deltaSeconds = (deltaPx / rect.width) * span
      setView(clampView({ start: panOrigin.viewStart - deltaSeconds, end: panOrigin.viewStart - deltaSeconds + span }, duration))
      return
    }

    // Idle hover: show a "grab" cursor when close enough to a marker.
    const nearestIndex = findNearestShotIndex(time, pixelToleranceSeconds(MARKER_HIT_RADIUS_PX))
    container.style.cursor = nearestIndex !== -1 ? 'grab' : isZoomed ? 'ew-resize' : ''
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    const draggedIndex = draggingIndexRef.current
    const didMoveMarker = draggedIndex !== null && dragMovedRef.current
    draggingIndexRef.current = null
    pendingMarkerRef.current = null
    panOriginRef.current = null
    if (didMoveMarker) onMoveShotEnd(draggedIndex)
  }

  const handleTogglePlay = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    const video = videoRef.current
    if (!video) return
    if (video.paused) void video.play()
    else video.pause()
  }

  const handlePointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    if (draggingIndexRef.current !== null || pendingMarkerRef.current || panOriginRef.current) return
    event.currentTarget.style.cursor = ''
  }

  const zoomLabel = useMemo(() => {
    const span = view.end - view.start
    if (span >= duration - 1e-6) return t('onset.fullClip')
    return t('onset.range', {
      start: view.start.toFixed(2),
      end: view.end.toFixed(2),
    })
  }, [view, duration, t])

  const legendShotColor = visualProfile === 'shots-first' ? SHOTS_FIRST_SHOT_COLOR : DEFAULT_SHOT_COLOR

  /**
   * What the arrows move. The TIME is stored, not the index: the list is re-sorted after
   * every move, and the index under the selected marker slides onto a neighbour.
   */
  const selectedIndex = selectedTime === null
    ? -1
    : shots.reduce(
        (best, shot, index) =>
          Math.abs(shot.time - selectedTime) < Math.abs((shots[best]?.time ?? Infinity) - selectedTime)
            ? index
            : best,
        -1,
      )

  const nudge = (delta: number) => {
    if (selectedIndex < 0 || !shots[selectedIndex]) return
    const next = Math.max(0, Math.min(duration, shots[selectedIndex].time + delta))
    onMoveShot(selectedIndex, next)
    onMoveShotEnd(selectedIndex)
    setSelectedTime(next)
    const video = videoRef.current
    if (video) video.currentTime = next
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!selectable || selectedIndex < 0) return
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      nudge(-NUDGE_SECONDS)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      nudge(NUDGE_SECONDS)
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      onRemoveShot(selectedIndex)
      setSelectedTime(null)
    }
  }

  const canvasBlock = (
    <div
      className="onset-view__canvas"
      ref={containerRef}
      tabIndex={selectable ? 0 : undefined}
      onKeyDown={handleKeyDown}
      onClick={handleSeek}
      onDoubleClick={handleToggleShot}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onPointerLeave={handlePointerLeave}
    >
      <canvas ref={baseCanvasRef} className="onset-view__layer" />
      <canvas ref={overlayCanvasRef} className="onset-view__layer" />
      {!readOnly && (
        <button
          type="button"
          className="onset-view__play-button"
          onClick={handleTogglePlay}
          onPointerDown={(event) => event.stopPropagation()}
          /* A double-click on the button is two play/pause presses, nothing more.
             Without stopping it, it bubbled up to the track and placed a marker there: the
             start of the clip is right under the button, and every quick repeat click on
             pause added a shot at second zero. */
          onDoubleClick={(event) => event.stopPropagation()}
          aria-label={isPlaying ? t('onset.pause') : t('onset.play')}
        >
          {isPlaying ? '⏸' : '▶'}
        </button>
      )}
      {!readOnly && isZoomed && (
        <button
          type="button"
          className="onset-view__zoom-reset"
          onClick={(event) => {
            event.stopPropagation()
            setView({ start: 0, end: duration })
          }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {zoomLabel} · {t('onset.resetZoom')}
        </button>
      )}
    </div>
  )

  // Time ruler: four ticks across the visible stretch. Without it the track is a
  // scaleless picture, and “the shot at second eight” can't be found on it.
  const rulerBlock = (
    <div className="onset-view__ruler" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => {
        const at = view.start + ((view.end - view.start) * i) / 3
        const mm = Math.floor(at / 60)
        const ss = Math.floor(at % 60)
        return <span key={i}>{`${mm}:${String(ss).padStart(2, '0')}`}</span>
      })}
    </div>
  )

  return (
    <div className={`onset-view${embedded ? ' onset-view--embedded' : ''}`}>
      {embedded ? (
        /*
         * The track is a SEPARATE card from the video, like `.track` in the mockup: its own
         * border, background and spacing, not set flush into a shared block with the video.
         * Only this branch changes — the labelling tool's markup (`else` below) was already self-contained.
         */
        <div className="onset-view__track">
          {canvasBlock}
          {rulerBlock}
        </div>
      ) : (
        <>
          {canvasBlock}
          {rulerBlock}
        </>
      )}
      {embedded ? (
        /*
         * THE HINT IS NO LONGER HERE. It explained the editing gestures, but the same view
         * now also sits on the check screen, where there's nothing to edit: instructions there
         * would distract from the only action needed — listening. The edit screen draws the hint,
         * under the stepping buttons, like `.track-hint` in the mockup.
         */
        null
      ) : (
        <div className="onset-view__legend">
          {referenceShots && referenceShots.length > 0 && (
            <span className="onset-view__legend-item">
              <i className="onset-view__swatch" style={{ background: legendShotColor }} />
              {t('onset.shotMarkers')}
            </span>
          )}
          {referenceShots && referenceShots.length > 0 && (
            <span className="onset-view__legend-item">
              <i className="onset-view__swatch" style={{ background: REFERENCE_COLOR }} />
              {t('onset.detectorLane')}
            </span>
          )}
          <span className="onset-view__legend-item onset-view__legend-item--hint">
            {t('onset.hint')}
          </span>
        </div>
      )}
    </div>
  )
}
