import type { ClipLabels } from '../../domain/detection/labels'

/** Mirrors `ClipEntry` in `scripts/labelerServer.ts`. */
export interface ClipEntry {
  slug: string
  file: string
  bytes: number
  hasLabels: boolean
  hasCache: boolean
  shotCount: number
  complete: boolean
}

const API_PREFIX = '/__labeler'

async function expectOk(response: Response, action: string): Promise<Response> {
  if (response.ok) return response
  let detail = response.statusText
  try {
    const body = (await response.json()) as { error?: string }
    if (body.error) detail = body.error
  } catch {
    // Non-JSON error body; the status text will have to do.
  }
  throw new Error(`${action} failed: ${detail}`)
}

export async function fetchClips(): Promise<ClipEntry[]> {
  const response = await expectOk(await fetch(`${API_PREFIX}/clips`), 'Loading clip list')
  return (await response.json()) as ClipEntry[]
}

export function clipMediaUrl(slug: string): string {
  return `${API_PREFIX}/media/${encodeURIComponent(slug)}`
}

/** Returns null when the clip has not been labeled yet. */
export async function fetchLabels(slug: string): Promise<ClipLabels | null> {
  const response = await fetch(`${API_PREFIX}/labels/${encodeURIComponent(slug)}`)
  if (response.status === 404) return null
  await expectOk(response, 'Loading labels')
  return (await response.json()) as ClipLabels
}

export async function saveLabels(labels: ClipLabels): Promise<void> {
  await expectOk(
    await fetch(`${API_PREFIX}/labels/${encodeURIComponent(labels.slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(labels),
    }),
    'Saving labels',
  )
}

export async function saveAudioCache(slug: string, wav: Blob): Promise<void> {
  await expectOk(
    await fetch(`${API_PREFIX}/cache/${encodeURIComponent(slug)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'audio/wav' },
      body: wav,
    }),
    'Saving audio cache',
  )
}

/** Downloads a clip from the dev server as a `File`, so it can go through the normal analysis path. */
export async function fetchClipFile(entry: ClipEntry): Promise<File> {
  const response = await expectOk(await fetch(clipMediaUrl(entry.slug)), 'Downloading clip')
  const blob = await response.blob()
  return new File([blob], entry.file, { type: blob.type || 'video/mp4' })
}
