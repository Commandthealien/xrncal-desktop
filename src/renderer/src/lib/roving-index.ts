/**
 * Walking a list of options with the arrow keys.
 *
 * Every picker in the app draws its list into a portal at the end of `<body>`,
 * miles from the field in tab order, so none of them can be reached by tabbing
 * into the list. Focus stays on the trigger and a roving index moves instead —
 * which makes "where does the next arrow press land" a plain function of the
 * list, testable without a DOM.
 */

/** Options are plain values unless the caller can say which are unselectable. */
export type DisabledPredicate<T> = (item: T) => boolean

const never = (): boolean => false

/**
 * The index `delta` steps away from `current`, skipping disabled entries and
 * wrapping around the ends. Returns `current` when nothing else can be landed
 * on, and -1 for a list with nothing selectable in it at all.
 */
export function nextEnabledIndex<T>(
  items: T[],
  current: number,
  delta: number,
  isDisabled: DisabledPredicate<T> = never
): number {
  const count = items.length
  if (count === 0) return -1
  if (current < 0 || current >= count) return firstEnabledIndex(items, delta < 0 ? 'end' : 'start', isDisabled)

  let next = current
  for (let i = 0; i < count; i++) {
    next = (next + delta + count) % count
    if (!isDisabled(items[next])) return next
  }
  // Every other entry is disabled; staying put beats jumping onto one of them.
  return current
}

/** The first selectable index from either end, or -1 if there is none. */
export function firstEnabledIndex<T>(
  items: T[],
  from: 'start' | 'end',
  isDisabled: DisabledPredicate<T> = never
): number {
  const order =
    from === 'start'
      ? items.map((_, i) => i)
      : items.map((_, i) => items.length - 1 - i)
  const found = order.find((i) => !isDisabled(items[i]))
  return found === undefined ? -1 : found
}
