/**
 * Touch support for the calendar's direct-manipulation gestures.
 *
 * The views drive two gestures that a phone cannot produce on its own:
 *
 *  - Moving an event uses the HTML5 drag-and-drop API (`draggable`,
 *    `dragstart`, `dataTransfer`). Touch input never generates those events -
 *    not slowly, not with a long press - so dragging an event did nothing at
 *    all on a device.
 *  - Dragging across empty grid to pick a time range uses `mousedown` /
 *    `mousemove` / `mouseup`. A touch produces a synthetic mousedown/mouseup
 *    pair on tap, but no moves in between, so range selection never started.
 *
 * Rather than rewrite those hooks - they are shared with the desktop build,
 * carry their own unit-tested geometry, and would have to be re-tuned on both
 * platforms - this synthesises the events they already expect, from touch.
 * The events are *real* `DragEvent`s and `MouseEvent`s carrying a real
 * `DataTransfer`, so React's handlers receive them exactly as they would from
 * a mouse and none of the existing logic has to know a finger was involved.
 *
 * The gesture is long-press-then-drag, which is the Android convention and
 * also the only option: an immediate drag is indistinguishable from a scroll,
 * and the calendar grid scrolls in both directions.
 */

/** Hold before a drag arms. Long enough not to fire while scrolling. */
const LONG_PRESS_MS = 320
/** Moving further than this before the hold completes means "scroll". */
const MOVE_SLOP_PX = 12
/** Distance from a scrollable edge at which auto-scroll kicks in. */
const EDGE_SCROLL_MARGIN_PX = 64
/** Auto-scroll speed at the very edge, in px per frame. */
const EDGE_SCROLL_MAX_PX = 18

type SessionKind = 'dnd' | 'range'

interface Session {
  kind: SessionKind
  source: HTMLElement
  dataTransfer: DataTransfer
  ghost: HTMLElement | null
  /** Element the finger is currently over, for enter/leave bookkeeping. */
  over: Element | null
  /** Whether the last `dragover` was cancelled, i.e. a drop is allowed. */
  dropAllowed: boolean
  scrollers: HTMLElement[]
  rafId: number | null
  x: number
  y: number
}

let pending: { x: number; y: number; target: Element; timer: number } | null = null
let session: Session | null = null

function buzz(ms: number): void {
  try {
    navigator.vibrate?.(ms)
  } catch {
    // Vibration is a nicety; a device that refuses it changes nothing.
  }
}

/**
 * Elements whose own gestures must win over dragging.
 *
 * The resize handles are in this list even though they sit *inside* a
 * draggable event block. They drive their own pointer-event stream, which
 * starts on contact, so a quick pull already resizes; without excluding them,
 * resting a finger on the handle for a third of a second would silently turn
 * an intended resize into a move.
 */
function isInert(target: Element): boolean {
  return Boolean(
    target.closest(
      'input, textarea, select, button, a, [role="dialog"], .gc-dialog, .gc-overlay, ' +
        '.gc-drawer, .gc-bottom-nav, .gc-mobile-header, [data-no-touch-drag], ' +
        '[class*="cursor-ns-resize"], [class*="cursor-n-resize"], [class*="cursor-s-resize"]'
    )
  )
}

/** Every scrollable ancestor, so a drag can reach off-screen days and hours. */
function scrollableAncestors(el: Element | null): HTMLElement[] {
  const out: HTMLElement[] = []
  let node: Element | null = el
  while (node && node !== document.body) {
    if (node instanceof HTMLElement) {
      const cs = getComputedStyle(node)
      const scrolls = /(auto|scroll)/.test(cs.overflowX + cs.overflowY)
      const canScroll =
        node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 1
      if (scrolls && canScroll) out.push(node)
    }
    node = node.parentElement
  }
  return out
}

function makeGhost(source: HTMLElement, x: number, y: number): HTMLElement {
  const rect = source.getBoundingClientRect()
  const ghost = source.cloneNode(true) as HTMLElement
  ghost.classList.add('gc-touch-drag-ghost')
  ghost.style.width = `${rect.width}px`
  ghost.style.height = `${rect.height}px`
  // Offset so the block keeps its grab point under the finger rather than
  // jumping its top-left corner there.
  ghost.dataset.grabX = String(x - rect.left)
  ghost.dataset.grabY = String(y - rect.top)
  document.body.appendChild(ghost)
  positionGhost(ghost, x, y)
  return ghost
}

function positionGhost(ghost: HTMLElement, x: number, y: number): void {
  const gx = Number(ghost.dataset.grabX ?? 0)
  const gy = Number(ghost.dataset.grabY ?? 0)
  ghost.style.transform = `translate3d(${x - gx}px, ${y - gy}px, 0)`
}

function dispatchDrag(
  type: string,
  target: Element,
  dataTransfer: DataTransfer,
  x: number,
  y: number
): boolean {
  const event = new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    dataTransfer
  })
  target.dispatchEvent(event)
  // A cancelled dragover is how the DnD spec says "you may drop here"; the
  // existing handlers already call preventDefault for valid targets.
  return event.defaultPrevented
}

function dispatchMouse(type: string, target: EventTarget, x: number, y: number): void {
  target.dispatchEvent(
    new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: type === 'mouseup' ? 0 : 1
    })
  )
}

/** The element under the finger; the ghost is pointer-events:none so it is skipped. */
function targetAt(x: number, y: number): Element | null {
  return document.elementFromPoint(x, y)
}

function beginSession(kind: SessionKind, source: HTMLElement, x: number, y: number): void {
  const dataTransfer = new DataTransfer()

  session = {
    kind,
    source,
    dataTransfer,
    ghost: null,
    over: null,
    dropAllowed: false,
    scrollers: scrollableAncestors(source),
    rafId: null,
    x,
    y
  }

  if (kind === 'dnd') {
    dispatchDrag('dragstart', source, dataTransfer, x, y)
    session.ghost = makeGhost(source, x, y)
    // Mirrors the desktop drag's dimmed original.
    source.classList.add('gc-touch-drag-source')
  } else {
    dispatchMouse('mousedown', source, x, y)
  }

  buzz(12)
  startAutoScroll()
}

function startAutoScroll(): void {
  const step = (): void => {
    if (!session) return
    const { x, y } = session
    for (const scroller of session.scrollers) {
      const r = scroller.getBoundingClientRect()

      if (scroller.scrollHeight > scroller.clientHeight + 1) {
        if (y < r.top + EDGE_SCROLL_MARGIN_PX) {
          scroller.scrollTop -= ramp(r.top + EDGE_SCROLL_MARGIN_PX - y)
        } else if (y > r.bottom - EDGE_SCROLL_MARGIN_PX) {
          scroller.scrollTop += ramp(y - (r.bottom - EDGE_SCROLL_MARGIN_PX))
        }
      }

      if (scroller.scrollWidth > scroller.clientWidth + 1) {
        // The week grid only shows three days on a phone, so reaching Friday
        // depends entirely on this.
        if (x < r.left + EDGE_SCROLL_MARGIN_PX) {
          scroller.scrollLeft -= ramp(r.left + EDGE_SCROLL_MARGIN_PX - x)
        } else if (x > r.right - EDGE_SCROLL_MARGIN_PX) {
          scroller.scrollLeft += ramp(x - (r.right - EDGE_SCROLL_MARGIN_PX))
        }
      }
    }
    session.rafId = requestAnimationFrame(step)
  }
  session!.rafId = requestAnimationFrame(step)
}

function ramp(depth: number): number {
  const t = Math.min(1, Math.max(0, depth / EDGE_SCROLL_MARGIN_PX))
  return t * EDGE_SCROLL_MAX_PX
}

function moveSession(x: number, y: number): void {
  if (!session) return
  session.x = x
  session.y = y

  if (session.kind === 'range') {
    // The slot hook listens on window, matching how a mouse drag behaves once
    // the button is held down.
    dispatchMouse('mousemove', window, x, y)
    return
  }

  if (session.ghost) positionGhost(session.ghost, x, y)

  const over = targetAt(x, y)
  if (over !== session.over) {
    if (session.over) dispatchDrag('dragleave', session.over, session.dataTransfer, x, y)
    if (over) dispatchDrag('dragenter', over, session.dataTransfer, x, y)
    session.over = over
  }
  if (over) {
    session.dropAllowed = dispatchDrag('dragover', over, session.dataTransfer, x, y)
  }
}

function endSession(commit: boolean): void {
  if (!session) return
  const s = session
  session = null

  if (s.rafId !== null) cancelAnimationFrame(s.rafId)
  s.ghost?.remove()
  s.source.classList.remove('gc-touch-drag-source')

  if (s.kind === 'range') {
    dispatchMouse('mouseup', window, s.x, s.y)
    return
  }

  if (commit && s.dropAllowed && s.over) {
    dispatchDrag('drop', s.over, s.dataTransfer, s.x, s.y)
    buzz(8)
  }
  // dragend runs either way so the views can clear their drag state.
  dispatchDrag('dragend', s.source, s.dataTransfer, s.x, s.y)
}

function clearPending(): void {
  if (pending) {
    clearTimeout(pending.timer)
    pending = null
  }
}

/**
 * Installs the gesture listeners. Safe to call once at boot; the listeners
 * live for the lifetime of the page.
 */
export function installTouchDrag(): void {
  document.addEventListener(
    'touchstart',
    (e) => {
      if (session || e.touches.length !== 1) return
      const touch = e.touches[0]
      const target = document.elementFromPoint(touch.clientX, touch.clientY)
      if (!target || isInert(target)) return

      // Only inside the calendar surface; the chrome has its own gestures.
      if (!target.closest('main')) return

      const timer = window.setTimeout(() => {
        const start = pending
        pending = null
        if (!start) return

        const draggable = start.target.closest<HTMLElement>('[draggable="true"]')
        if (draggable) {
          beginSession('dnd', draggable, start.x, start.y)
        } else if (start.target instanceof HTMLElement) {
          beginSession('range', start.target, start.x, start.y)
        }
      }, LONG_PRESS_MS)

      pending = { x: touch.clientX, y: touch.clientY, target, timer }
    },
    { passive: true }
  )

  document.addEventListener(
    'touchmove',
    (e) => {
      const touch = e.touches[0]
      if (!touch) return

      if (pending) {
        // Still deciding. Any real movement means the user is scrolling.
        const dx = Math.abs(touch.clientX - pending.x)
        const dy = Math.abs(touch.clientY - pending.y)
        if (dx > MOVE_SLOP_PX || dy > MOVE_SLOP_PX) clearPending()
        return
      }

      if (!session) return
      // Now that a drag owns the gesture, the grid must not scroll under it.
      // This is why the listener cannot be passive.
      e.preventDefault()
      moveSession(touch.clientX, touch.clientY)
    },
    { passive: false }
  )

  document.addEventListener('touchend', () => {
    clearPending()
    endSession(true)
  })

  document.addEventListener('touchcancel', () => {
    clearPending()
    endSession(false)
  })

  // A second finger during a drag (a pinch, usually) abandons it rather than
  // letting the gesture drift somewhere unintended.
  document.addEventListener('touchstart', (e) => {
    if (session && e.touches.length > 1) endSession(false)
  })
}
