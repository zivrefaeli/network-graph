/**
 * Screens narrow enough that the details panel becomes a sheet over the canvas
 * and the legend would cover most of what it is explaining. Kept beside the
 * matching breakpoint in styles.css -- the two have to agree.
 */
export const NARROW_SCREEN_QUERY = '(max-width: 900px)'

/**
 * jsdom implements no matchMedia at all, and neither do the older engines this
 * might be opened in. Answering "not narrow" is the safe default: it shows the
 * full layout rather than hiding things on a screen with room for them.
 */
export function matchesNarrowScreen(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia(NARROW_SCREEN_QUERY).matches
}
