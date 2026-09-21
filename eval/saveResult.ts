/**
 * Sends a research page's result straight into `eval/.cache/`.
 *
 * Received by a dev endpoint from `scripts/evalCacheServer.ts`. Pages used to hand files over
 * as downloads, and the browser asked for confirmation on each one — three dialogs per run.
 *
 * If there is no endpoint (the page is not opened under `vite dev`), the result is still not lost:
 * it falls back to a download.
 */
export async function saveResult(name: string, data: BlobPart, type: string): Promise<string> {
  try {
    const r = await fetch(`/__cache/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': type },
      body: data instanceof Blob ? data : new Blob([data], { type }),
    })
    if (r.ok) {
      const { saved, bytes } = (await r.json()) as { saved: string; bytes: number }
      return `сохранено ${saved} (${(bytes / 1024 / 1024).toFixed(1)} МБ)`
    }
  } catch {
    // No endpoint — fall back below.
  }
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([data], { type }))
  a.download = name
  a.click()
  URL.revokeObjectURL(a.href)
  return `${name} отдан на скачивание (dev-ручка недоступна) — положить в eval/.cache/`
}
