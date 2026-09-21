/**
 * Translation key for a library sound's label.
 *
 * The domain keeps only a stable sound id (`domain/audio/soundLibrary`): it can't import
 * i18n (ADR 0001). The visible name is looked up here by that id, so every screen that
 * shows the current sound — the arsenal, the check, the summary — uses the same key and
 * switches language together with the rest of the page.
 */
export function librarySoundKey(id: string): string {
  return `library.sounds.${id}`
}
