/**
 * Turning a wheel gesture into a step through the calendar.
 *
 * Month and Year navigate from anywhere on the page. Day and Week navigate
 * from their header band only - the hour grid below keeps the wheel for
 * scrolling the 24 hours, which is the whole point of it - and the all-day
 * strip inside that band scrolls itself once it is full. So "did this gesture
 * mean navigate?" has enough rules in it to be worth answering away from
 * React. Pure on purpose: the hook owns the DOM and the timestamps, this owns
 * the decision.
 */

/** Below this a wheel event is a trackpad settling, not a scroll. */
export const WHEEL_DELTA_THRESHOLD = 8

/**
 * A step is taken on the *first* event of a gesture rather than on a throttle:
 * one trackpad flick emits events for a second or more, and throttling stepped
 * several periods per flick. Anything arriving within this gap of the last
 * wheel event is that flick's inertia and is ignored.
 */
export const WHEEL_GESTURE_GAP_MS = 220

/** The bit of a scroll container this decision needs. */
export interface ScrollerMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface WheelNavigationInput {
  deltaY: number
  /** `Date.now()` at the event. */
  now: number
  /** When the last wheel event of any kind arrived. */
  lastWheelAt: number
  /**
   * The scroller the pointer is inside, or null when it is over something that
   * does not scroll. The all-day strip has to win while it still has lanes to
   * reveal, or the ones past the cap would be unreachable; the day names
   * beside it scroll nothing and navigate straight away.
   */
  scroller?: ScrollerMetrics | null
}

export interface WheelNavigationOutcome {
  /** -1 back, +1 forward, 0 for "this gesture was not a step". */
  step: -1 | 0 | 1
  /** The gesture clock to carry into the next event. */
  lastWheelAt: number
}

/** Whether the scroller can still absorb a scroll in this direction. */
function canScrollFurther(m: ScrollerMetrics, deltaY: number): boolean {
  const slack = m.scrollHeight - m.clientHeight
  // Sub-pixel slack is a rounding artefact, not a scrollable region.
  if (slack <= 1) return false
  return deltaY > 0 ? m.scrollTop < slack - 1 : m.scrollTop > 0
}

export function wheelNavigation({
  deltaY,
  now,
  lastWheelAt,
  scroller = null
}: WheelNavigationInput): WheelNavigationOutcome {
  // Left out of the gesture clock entirely: a stray sub-threshold event should
  // neither arm a step nor keep one suppressed.
  if (Math.abs(deltaY) < WHEEL_DELTA_THRESHOLD) return { step: 0, lastWheelAt }

  // Every event above the threshold counts as part of the gesture, including
  // the ones the scroller consumes. Reaching the end of the all-day strip and
  // stepping the week on the same flick is the alternative, and it overshoots.
  if (scroller && canScrollFurther(scroller, deltaY)) return { step: 0, lastWheelAt: now }
  if (now - lastWheelAt < WHEEL_GESTURE_GAP_MS) return { step: 0, lastWheelAt: now }

  return { step: deltaY > 0 ? 1 : -1, lastWheelAt: now }
}
