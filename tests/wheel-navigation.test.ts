import { describe, it, expect } from 'vitest'
import {
  wheelNavigation,
  WHEEL_DELTA_THRESHOLD,
  WHEEL_GESTURE_GAP_MS,
  type ScrollerMetrics
} from '../src/renderer/src/lib/wheel-navigation'

/**
 * The two things this has to get right are "one flick is one step" and "an
 * inner scroller gets the gesture until it runs out" - the second is what lets
 * Day and Week's all-day strip reveal its hidden lanes before the wheel moves
 * on to the next day or week.
 */

/** A scroller with room left in both directions. */
const midway: ScrollerMetrics = { scrollTop: 400, scrollHeight: 1440, clientHeight: 600 }
const atTop: ScrollerMetrics = { scrollTop: 0, scrollHeight: 1440, clientHeight: 600 }
const atBottom: ScrollerMetrics = { scrollTop: 840, scrollHeight: 1440, clientHeight: 600 }
/** Month view: the page fits, so there is nothing to scroll. */
const noSlack: ScrollerMetrics = { scrollTop: 0, scrollHeight: 600, clientHeight: 600 }

describe('wheelNavigation', () => {
  it('steps forward on a downward flick', () => {
    expect(wheelNavigation({ deltaY: 120, now: 1000, lastWheelAt: 0 }).step).toBe(1)
  })

  it('steps back on an upward flick', () => {
    expect(wheelNavigation({ deltaY: -120, now: 1000, lastWheelAt: 0 }).step).toBe(-1)
  })

  it('ignores the small deltas a trackpad emits while settling', () => {
    const out = wheelNavigation({
      deltaY: WHEEL_DELTA_THRESHOLD - 1,
      now: 1000,
      lastWheelAt: 300
    })
    expect(out.step).toBe(0)
    // And it does not touch the gesture clock, so it can neither arm the next
    // step nor keep one suppressed.
    expect(out.lastWheelAt).toBe(300)
  })

  it('takes one step per flick, however long its inertia runs', () => {
    let last = 0
    const steps: number[] = []
    // One flick: an event every 16ms for half a second.
    for (let t = 1000; t < 1500; t += 16) {
      const out = wheelNavigation({ deltaY: 40, now: t, lastWheelAt: last })
      last = out.lastWheelAt
      steps.push(out.step)
    }
    expect(steps.filter((s) => s !== 0)).toEqual([1])
  })

  it('steps again once the gesture has ended', () => {
    const first = wheelNavigation({ deltaY: 120, now: 1000, lastWheelAt: 0 })
    const next = wheelNavigation({
      deltaY: 120,
      now: 1000 + WHEEL_GESTURE_GAP_MS,
      lastWheelAt: first.lastWheelAt
    })
    expect(next.step).toBe(1)
  })

  it('lets a scroller with room left keep the gesture', () => {
    expect(wheelNavigation({ deltaY: 120, now: 1000, lastWheelAt: 0, scroller: midway }).step).toBe(0)
    expect(wheelNavigation({ deltaY: -120, now: 1000, lastWheelAt: 0, scroller: midway }).step).toBe(0)
  })

  it('steps once the scroller is against the edge the wheel is pushing', () => {
    expect(wheelNavigation({ deltaY: 120, now: 1000, lastWheelAt: 0, scroller: atBottom }).step).toBe(1)
    expect(wheelNavigation({ deltaY: -120, now: 1000, lastWheelAt: 0, scroller: atTop }).step).toBe(-1)
  })

  it('still scrolls away from the edge it is resting on', () => {
    expect(wheelNavigation({ deltaY: -120, now: 1000, lastWheelAt: 0, scroller: atBottom }).step).toBe(0)
    expect(wheelNavigation({ deltaY: 120, now: 1000, lastWheelAt: 0, scroller: atTop }).step).toBe(0)
  })

  it('does not scroll to the end and step on the same flick', () => {
    // Reaching the last all-day lane mid-flick must not also move the week:
    // the events the scroller consumed are part of the gesture too.
    let last = 0
    let scroller = midway
    const steps: number[] = []
    for (let t = 1000; t < 1400; t += 16) {
      const out = wheelNavigation({ deltaY: 60, now: t, lastWheelAt: last, scroller })
      last = out.lastWheelAt
      steps.push(out.step)
      if (t > 1100) scroller = atBottom
    }
    expect(steps.every((s) => s === 0)).toBe(true)
  })

  it('treats a container with nothing to scroll as no scroller at all', () => {
    expect(wheelNavigation({ deltaY: 120, now: 1000, lastWheelAt: 0, scroller: noSlack }).step).toBe(1)
  })
})
