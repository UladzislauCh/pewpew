import type { StateCreator } from 'zustand'

/**
 * State of the site's main menu.
 *
 * The menu lives in the header but closes for three different reasons: the Escape key,
 * a click outside and a route change. While the flag sat in the header's `useState`, each
 * reason had to be wired up there — and anyone needing to close the menu from outside
 * (say, a button inside a page) would have had to thread a callback through the whole tree.
 *
 * The state here has no DOM: event subscriptions stay in the component, because that's
 * its job, and the slice only stores “open or not”.
 */
export interface MenuState {
  /** Whether the main menu is open. On a wide screen the items are always visible and the flag is unused. */
  isMenuOpen: boolean
  openMenu: () => void
  closeMenu: () => void
  toggleMenu: () => void
}

export const createMenuSlice: StateCreator<MenuState, [], [], MenuState> = (set) => ({
  isMenuOpen: false,
  openMenu: () => set({ isMenuOpen: true }),
  closeMenu: () => set({ isMenuOpen: false }),
  toggleMenu: () => set((s) => ({ isMenuOpen: !s.isMenuOpen })),
})
