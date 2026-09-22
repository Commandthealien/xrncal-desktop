import { useEffect } from 'react'

/**
 * Keep WeekView's two grids horizontally aligned.
 *
 * WeekView paints the weekday header and the hour grid as two sibling
 * elements that share a column template. On desktop that is invisible because
 * all seven columns always fit. On a phone the stylesheet gives each column a
 * minimum width and lets the grid scroll sideways - at which point the two
 * grids scroll independently and the labels drift away from their columns.
 *
 * Mirroring scrollLeft is cheaper and far less invasive than restructuring
 * WeekView into a single scroll container, which would mean moving the sticky
 * header inside the vertically scrolling element.
 */
export function useWeekScrollSync(): void {
  useEffect(() => {
    let header: HTMLElement | null = null
    let body: HTMLElement | null = null
    // Guards the echo: setting scrollLeft on one element fires its own scroll
    // event, which would immediately write back to the other.
    let syncing = false

    const mirror = (from: HTMLElement, to: HTMLElement) => () => {
      if (syncing) return
      syncing = true
      to.scrollLeft = from.scrollLeft
      // Release on the next frame rather than synchronously: the assignment
      // above queues a scroll event that has not been dispatched yet.
      requestAnimationFrame(() => {
        syncing = false
      })
    }

    let onHeaderScroll: (() => void) | null = null
    let onBodyScroll: (() => void) | null = null

    const detach = (): void => {
      if (header && onHeaderScroll) header.removeEventListener('scroll', onHeaderScroll)
      if (body && onBodyScroll) body.removeEventListener('scroll', onBodyScroll)
      header = body = null
      onHeaderScroll = onBodyScroll = null
    }

    const attach = (): void => {
      const nextHeader = document.querySelector<HTMLElement>('.gc-week-header')
      const nextBody = document.querySelector<HTMLElement>('.gc-week-scroll')
      if (nextHeader === header && nextBody === body) return

      detach()
      if (!nextHeader || !nextBody) return

      header = nextHeader
      body = nextBody
      onHeaderScroll = mirror(header, body)
      onBodyScroll = mirror(body, header)
      header.addEventListener('scroll', onHeaderScroll, { passive: true })
      body.addEventListener('scroll', onBodyScroll, { passive: true })
    }

    attach()
    // The grids are mounted and unmounted as the user switches views, so the
    // listeners have to follow them.
    const observer = new MutationObserver(attach)
    observer.observe(document.body, { childList: true, subtree: true })

    return () => {
      observer.disconnect()
      detach()
    }
  }, [])
}
