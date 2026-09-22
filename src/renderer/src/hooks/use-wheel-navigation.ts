import React, { useCallback, useRef } from 'react'
import { wheelNavigation, type ScrollerMetrics } from '../lib/wheel-navigation'

export interface WheelNavigationOptions {
  onPrev?: () => void
  onNext?: () => void
  /**
   * A scroll container inside the region this is attached to, when there is
   * one. The wheel only defers to it while the pointer is actually inside it -
   * wheeling over the day names next to it navigates at once.
   */
  scrollerRef?: React.RefObject<HTMLElement | null>
}

/**
 * Wheel-to-navigate. Month and Year attach it to their root, Day and Week to
 * their header band - their hour grid keeps the wheel for scrolling hours.
 *
 * Returns a handler for `onWheel`; the step maths lives in
 * `lib/wheel-navigation.ts` and is unit-tested without a DOM.
 */
export function useWheelNavigation({
  onPrev,
  onNext,
  scrollerRef
}: WheelNavigationOptions): (e: React.WheelEvent) => void {
  const lastWheelAt = useRef(0)

  return useCallback(
    (e: React.WheelEvent) => {
      const target = e.target as Node | null

      // React bubbles events through the component tree, so a wheel inside a
      // portalled overlay this view rendered (the day peek popover, the drop
      // action menu) arrives here too. Those scroll themselves; DOM
      // containment is what tells them apart from the canvas.
      if (target && !e.currentTarget.contains(target)) return

      const el = scrollerRef?.current ?? null
      const inside = el !== null && target !== null && el.contains(target)
      const scroller: ScrollerMetrics | null =
        inside && el
          ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
          : null

      const outcome = wheelNavigation({
        deltaY: e.deltaY,
        now: Date.now(),
        lastWheelAt: lastWheelAt.current,
        scroller
      })
      lastWheelAt.current = outcome.lastWheelAt

      if (outcome.step === 1) onNext?.()
      else if (outcome.step === -1) onPrev?.()
    },
    [onPrev, onNext, scrollerRef]
  )
}

export default useWheelNavigation
