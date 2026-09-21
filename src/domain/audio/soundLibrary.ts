/**
 * Built-in replacement sounds served from `/sounds/`.
 * Filenames keep the Freesound `{id}__{user}__{slug}` form for attribution.
 * The visible name is not stored here: the UI translates it by `id` (`library.sounds.<id>`).
 */
export interface LibrarySound {
  id: string
  /** Public URL path, e.g. `/sounds/….wav`. */
  src: string
  /** Filename used when the sound is applied as a replacement. */
  fileName: string
}

export const SOUND_LIBRARY: LibrarySound[] = [
  {
    id: 'boing',
    src: '/sounds/140867__juskiddink__boing.wav',
    fileName: 'boing.wav',
  },
  {
    id: 'bonk',
    src: '/sounds/458572__facklere__bonk.wav',
    fileName: 'bonk.wav',
  },
  {
    id: 'bloop',
    src: '/sounds/55817__sergenious__bloop2.wav',
    fileName: 'bloop.wav',
  },
  {
    id: 'bubble',
    src: '/sounds/337133__cdonahueucsd__bubble_big.wav',
    fileName: 'bubble.wav',
  },
  {
    id: 'cash-register',
    src: '/sounds/201159__kiddpark__cash-register.mp3',
    fileName: 'cash-register.mp3',
  },
  {
    id: 'drop-of-water',
    src: '/sounds/725032__icsp__drop-of-water.ogg',
    fileName: 'drop-of-water.ogg',
  },
  {
    id: 'glug',
    src: '/sounds/221488__lloydevans09__glug.wav',
    fileName: 'glug.wav',
  },
  {
    id: 'splash',
    src: '/sounds/398032__swordofkings128__splash.wav',
    fileName: 'splash.wav',
  },
  {
    id: 'water-drop',
    src: '/sounds/853900__alexzavesa__water-drop-tap-4.wav',
    fileName: 'water-drop.wav',
  },
  {
    id: 'water-splash',
    src: '/sounds/110393__soundscalpelcom__water_splash.wav',
    fileName: 'water-splash.wav',
  },
  {
    id: 'wet-splat',
    src: '/sounds/495117__nebulasnails__wet-splat-2.mp3',
    fileName: 'wet-splat.mp3',
  },
  {
    id: 'wind',
    src: '/sounds/17296__luffy__luffy_wind2.wav',
    fileName: 'wind.wav',
  },
  {
    id: 'metal',
    src: '/sounds/168822__debsound__metal-06.wav',
    fileName: 'metal.wav',
  },
  {
    id: 'meow',
    src: '/sounds/385892__spacether__262312__steffcaffrey__cat-meow1.mp3',
    fileName: 'meow.mp3',
  },
  {
    id: 'squeaky-toy',
    src: '/sounds/468443__breviceps__squeaky-toy-1.wav',
    fileName: 'squeaky-toy.wav',
  },
  {
    id: 'rubber-chicken',
    src: '/sounds/475734__dogwomble__rubber-chicken-1.wav',
    fileName: 'rubber-chicken.wav',
  },
]

export function getLibrarySound(id: string): LibrarySound | undefined {
  return SOUND_LIBRARY.find((sound) => sound.id === id)
}

/**
 * The meme sound that's selected right after analysis — before the user has picked one.
 *
 * SHORT WITH A SHARP ATTACK, and that's not a taste choice: on the review screen the user
 * judges whether labels hit BY EAR. A long sound over a five-shot burst blurs into one
 * smear, and a miss inside it is no longer audible — there's nothing left to check.
 */
export const DEFAULT_SOUND_ID = 'bonk'
