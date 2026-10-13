import { fetchWithTimeout, readTextWithin } from './http'
import { generateIcs } from '../ics/write-ics'
import { mergeServerCopy } from '../ics/merge-ics'
import {
  parseCalDavMultistatus,
  extractXmlText,
  extractPropHref,
  resolveDavHref,
  type CalDavCalendarDescriptor
} from './caldav-discover'
import type { Calendar, CalendarEvent, EventException } from '@shared/event-model'

/** A calendar resource from a REPORT; `ics` is absent when only etags were asked for. */
export interface CalDavItem {
  href: string
  ics?: string
  etag?: string
}

/** Resources per calendar-multiget request. */
const MULTIGET_BATCH = 100
/** A whole calendar of ~8,000 events is a few MB of XML; this is far past any real one. */
const MAX_REPORT_BYTES = 200 * 1024 * 1024
/** Time allowed for a REPORT's body once its headers are in. */
const REPORT_BODY_TIMEOUT_MS = 120_000

export interface CalDavCredentials {
  url: string
  username: string
  password: string
}

export class CalDavAdapter {
  private authHeader: string

  constructor(private creds: CalDavCredentials) {
    const token = Buffer.from(`${creds.username}:${creds.password}`).toString('base64')
    this.authHeader = `Basic ${token}`
  }

  /**
   * Helper: Dispatch CalDAV HTTP request with Basic Auth
   */
  private async request(
    url: string,
    method: string,
    body?: string,
    headers: Record<string, string> = {}
  ): Promise<Response> {
    return fetchWithTimeout(url, {
      method,
      headers: {
        Authorization: this.authHeader,
        ...headers
      },
      body
    })
  }

  /**
   * Discover calendar collections via PROPFIND
   */
  async discoverCalendars(): Promise<CalDavCalendarDescriptor[]> {
    // No sync-token: nothing uses it, and Radicale rebuilds per-item history to
    // answer it - 2 to 25 s per poll on the home server's 8,000 events, against
    // 1.6 s for the ctag alone, which is all that decides whether to pull.
    const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    <D:resourcetype/>
    <D:displayname/>
    <C:calendar-description/>
    <C:calendar-color/>
    <CS:getctag/>
    <D:current-user-privilege-set/>
  </D:prop>
</D:propfind>`

    const res = await this.request(this.creds.url, 'PROPFIND', propfindXml, {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    })

    if (!res.ok && res.status !== 207) {
      throw new Error(`CalDAV discovery failed with HTTP ${res.status}: ${await res.text()}`)
    }

    const xml = await res.text()
    return parseCalDavMultistatus(xml, this.creds.url)
  }

  /**
   * Find the user's calendars from whatever address they typed - a server root,
   * a principal or the calendar home itself - the way RFC 6764 clients "auto
   * detect": calendars at the address, else follow `current-user-principal`
   * (asking `/.well-known/caldav` when the address does not say) to its
   * `calendar-home-set`. Without this, a bare server URL connected "fine" and
   * then showed no calendars, because they live one or two levels down.
   *
   * Returns the URL to store as the account's base, so every later sync lists
   * calendars with the single PROPFIND in `discoverCalendars`.
   */
  async locateCalendarHome(): Promise<{ url: string; calendars: CalDavCalendarDescriptor[] }> {
    const start = this.creds.url
    const here = await this.calendarsAt(start)
    if (here.length > 0) return { url: start, calendars: here }

    const principal =
      (await this.propHref(start, 'current-user-principal')) ??
      (await this.propHref(resolveDavHref('/.well-known/caldav', start), 'current-user-principal'))
    if (!principal) return { url: start, calendars: [] }

    const home = await this.propHref(principal, 'calendar-home-set')
    if (!home) return { url: start, calendars: [] }

    return { url: home, calendars: await this.calendarsAt(home) }
  }

  /** Calendars directly under `url`; none (rather than an error) when the server
   *  will not list it, so discovery can move on. A 401 still throws. */
  private async calendarsAt(url: string): Promise<CalDavCalendarDescriptor[]> {
    const res = await this.propfind(url, '1', `<D:resourcetype/>
    <D:displayname/>
    <C:calendar-color/>
    <CS:getctag/>
    <D:current-user-privilege-set/>`)
    if (!res) return []
    return parseCalDavMultistatus(await res.text(), res.url || url)
  }

  /** The absolute href a single property on `url` points at, if the server has it. */
  private async propHref(url: string, prop: 'current-user-principal' | 'calendar-home-set'): Promise<string | undefined> {
    const res = await this.propfind(url, '0', prop === 'calendar-home-set' ? '<C:calendar-home-set/>' : '<D:current-user-principal/>')
    if (!res) return undefined
    const href = extractPropHref(await res.text(), prop)
    return href ? resolveDavHref(href, res.url || url) : undefined
  }

  /** PROPFIND, or null for the statuses that just mean "not here". */
  private async propfind(url: string, depth: '0' | '1', props: string): Promise<Response | null> {
    const res = await this.request(
      url,
      'PROPFIND',
      `<?xml version="1.0" encoding="utf-8" ?>
<D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CS="http://calendarserver.org/ns/">
  <D:prop>
    ${props}
  </D:prop>
</D:propfind>`,
      { Depth: depth, 'Content-Type': 'application/xml; charset=utf-8' }
    )
    if (res.status === 401) {
      throw new Error(`CalDAV discovery failed with HTTP 401: ${await res.text()}`)
    }
    if (res.status === 207 || res.ok) return res
    if ([403, 404, 405, 501].includes(res.status)) return null
    throw new Error(`CalDAV discovery failed with HTTP ${res.status}: ${await res.text()}`)
  }

  /**
   * Pull all ICS events from a calendar collection via CalDAV REPORT
   */
  async pullCalendarEvents(calendarUrl: string): Promise<{ rawIcsList: (CalDavItem & { ics: string })[] }> {
    const items = await this.eventQuery(calendarUrl, true)
    return { rawIcsList: items.filter((i): i is CalDavItem & { ics: string } => Boolean(i.ics)) }
  }

  /**
   * Every event resource in the calendar with its etag, and no data: a few
   * hundred KB for a calendar whose data runs to megabytes. Comparing the etags
   * with the stored ones says which resources need downloading at all.
   */
  async listEventEtags(calendarUrl: string): Promise<{ href: string; etag?: string }[]> {
    return (await this.eventQuery(calendarUrl, false)).map(({ href, etag }) => ({ href, etag }))
  }

  /**
   * Download the named resources (absolute hrefs, as listed) with a
   * calendar-multiget, MULTIGET_BATCH at a time. A resource deleted since it was
   * listed is simply missing from the result. Returns null when the server will
   * not do a multiget, so the caller can fall back to the full query.
   */
  async fetchEvents(calendarUrl: string, hrefs: string[]): Promise<CalDavItem[] | null> {
    const items: CalDavItem[] = []
    const origin = new URL(calendarUrl).origin

    for (let i = 0; i < hrefs.length; i += MULTIGET_BATCH) {
      const refs = hrefs.slice(i, i + MULTIGET_BATCH).map((href) => {
        // Servers expect the path they listed; another host's resource keeps its full URL.
        const url = new URL(href)
        return `  <D:href>${escapeXml(url.origin === origin ? url.pathname : href)}</D:href>`
      })
      const body = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>
    <C:calendar-data/>
  </D:prop>
${refs.join('\n')}
</C:calendar-multiget>`

      const res = await this.request(calendarUrl, 'REPORT', body, {
        Depth: '1',
        'Content-Type': 'application/xml; charset=utf-8'
      })
      if ([400, 403, 405, 415, 501].includes(res.status)) return null
      if (!res.ok && res.status !== 207) {
        throw new Error(`CalDAV multiget failed with HTTP ${res.status}: ${await res.text()}`)
      }
      const xml = await readTextWithin(res, calendarUrl, MAX_REPORT_BYTES, REPORT_BODY_TIMEOUT_MS)
      items.push(...parseCalendarItems(xml, res.url || calendarUrl).filter((item) => item.ics))
    }

    return items
  }

  private async eventQuery(calendarUrl: string, withData: boolean): Promise<CalDavItem[]> {
    const reportXml = `<?xml version="1.0" encoding="utf-8" ?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop>
    <D:getetag/>${withData ? '\n    <C:calendar-data/>' : ''}
  </D:prop>
  <C:filter>
    <C:comp-filter name="VCALENDAR">
      <C:comp-filter name="VEVENT"/>
    </C:comp-filter>
  </C:filter>
</C:calendar-query>`

    const res = await this.request(calendarUrl, 'REPORT', reportXml, {
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8'
    })

    if (!res.ok && res.status !== 207) {
      throw new Error(`CalDAV event query failed with HTTP ${res.status}: ${await res.text()}`)
    }

    // The request's deadline ends with the headers, and a server on a flaky link
    // can stall mid-body; that would hold SyncWorker.isSyncing for good.
    const xml = await readTextWithin(res, calendarUrl, MAX_REPORT_BYTES, REPORT_BODY_TIMEOUT_MS)
    return parseCalendarItems(xml, res.url || calendarUrl)
  }

  /**
   * Push an event to CalDAV collection via PUT. With the server's copy of it,
   * what other clients stored there and xrncal does not model is carried over
   * (mergeServerCopy); `body` is what was sent, the server's copy from now on.
   */
  async pushEvent(
    calendar: Calendar,
    event: CalendarEvent,
    exceptions: EventException[] = [],
    serverCopy?: { ics: string; keepAttendees: boolean }
  ): Promise<{ success: boolean; etag?: string; href?: string; conflict?: boolean; body?: string }> {
    // A CalDAV series lives in one resource, so per-occurrence overrides and
    // cancellations have to travel with the master as RECURRENCE-ID components;
    // omitting them silently strips the occurrence edit from the push.
    const generated = generateIcs(calendar, [event], exceptions)
    let icsContent = generated.replace('\r\nMETHOD:PUBLISH\r\n', '\r\n')
    if (serverCopy) {
      try {
        icsContent = mergeServerCopy(generated, serverCopy.ics, {
          tzid: event.tzid,
          reminders: event.reminders,
          keepAttendees: serverCopy.keepAttendees
        })
      } catch {
        // A copy that will not parse is no reason to hold the edit back.
      }
    }
    const eventUrl = event.providerEventId || eventUrlFor(calendar.id, event.uid || event.id)

    const headers: Record<string, string> = {
      'Content-Type': 'text/calendar; charset=utf-8'
    }
    if (event.etag) {
      headers['If-Match'] = event.etag
    }

    const res = await this.request(eventUrl, 'PUT', icsContent, headers)

    if (!res.ok && res.status !== 201 && res.status !== 204) {
      if (res.status === 412) {
        return { success: false, conflict: true }
      }
      throw new Error(`CalDAV PUT failed: HTTP ${res.status}`)
    }

    const newEtag = res.headers.get('ETag') || undefined
    return { success: true, etag: newEtag, href: eventUrl, body: icsContent }
  }

  /**
   * Delete an event from CalDAV collection via DELETE. `href` is where the
   * server keeps it; without one the UID-named address xrncal itself uses.
   */
  async deleteEvent(calendarUrl: string, eventUid: string, href?: string): Promise<boolean> {
    const res = await this.request(href || eventUrlFor(calendarUrl, eventUid), 'DELETE')
    return res.ok || res.status === 404
  }
}

/**
 * Where xrncal puts an event it creates. Other clients name their resources as
 * they like - not necessarily after the UID - so an event that came from the
 * server is addressed by the href the server listed it under instead.
 */
function eventUrlFor(calendarUrl: string, uid: string): string {
  return `${calendarUrl.replace(/\/+$/, '')}/${encodeURIComponent(uid)}.ics`
}


/** The `response` elements of a REPORT multistatus, with absolute hrefs so they can be stored and PUT or DELETEd as-is. */
function parseCalendarItems(xml: string, baseUrl: string): CalDavItem[] {
  const responseRegex = /<(?:[a-zA-Z0-9_-]+:)?response(?:[\s\S]*?)<\/(?:[a-zA-Z0-9_-]+:)?response>/gi
  const items: CalDavItem[] = []
  for (const resp of xml.match(responseRegex) || []) {
    const href = extractXmlText(resp, 'href')
    if (!href) continue
    items.push({
      href: resolveDavHref(href, baseUrl),
      ics: extractXmlText(resp, 'calendar-data') || undefined,
      etag: extractXmlText(resp, 'getetag') || undefined
    })
  }
  return items
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
