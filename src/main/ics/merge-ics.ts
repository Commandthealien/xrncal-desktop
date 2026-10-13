import ICAL from 'ical.js'
import { DateTime, IANAZone } from 'luxon'
import { normalizeReminders, type EventReminder } from '@shared/reminders'
import { alarmAsReminder } from './parse-ics'

/**
 * Carrying what the server's copy of an event holds, and xrncal does not model,
 * into an edit made here.
 *
 * A CalDAV push replaces the whole resource, and generateIcs() writes only the
 * fields this app models. Everything else another client had put there -
 * categories, attachments, the private and free/busy flags, an alarm at a fixed
 * time or after the end, an email alarm, its own X- properties - was erased by
 * any edit here, and the series was re-anchored in UTC, so a weekly 09:00 in a
 * zone with summer time moved by an hour twice a year. The generated copy stays
 * the authority for what xrncal owns; the server's copy supplies the rest.
 */

export interface ServerCopyOptions {
  /** The event's zone. When the server's copy was anchored in it, the times go back in that zone. */
  tzid?: string
  /** The reminders the generated copy was written from. */
  reminders?: readonly EventReminder[]
  /** The guest list was never read here and so was not sent: the server's stays. */
  keepAttendees?: boolean
}

/** Decided by the generated copy; the server's are dropped. */
const OWNED = new Set([
  'uid',
  'dtstamp',
  'dtstart',
  'dtend',
  'duration',
  'summary',
  'description',
  'location',
  'url',
  'color',
  'rrule',
  'exdate',
  'recurrence-id',
  'attendee',
  'organizer',
  'sequence',
  'last-modified'
])

/** Kept only while what they elaborate is unchanged: the notes' HTML twin, a place's map pin. */
const TIED: Record<string, string> = {
  'x-alt-desc': 'description',
  'x-apple-structured-location': 'location',
  geo: 'location'
}

/** Guest parameters the generated line decides, or that only a server may set. */
const OWNED_PARAMS = new Set(['cn', 'cutype', 'role', 'partstat', 'schedule-status'])

const TIMING = ['dtstart', 'dtend', 'recurrence-id', 'exdate']

export function mergeServerCopy(generated: string, serverCopy: string, options: ServerCopyOptions = {}): string {
  const out = new ICAL.Component(ICAL.parse(generated))
  const src = new ICAL.Component(ICAL.parse(serverCopy))
  // A resource in a calendar collection must not carry METHOD (RFC 4791 4.1).
  out.removeAllProperties('method')

  const zones = new Map<string, ICAL.Component>()
  for (const vtz of src.getAllSubcomponents('vtimezone')) {
    const id = vtz.getFirstPropertyValue('tzid')
    if (typeof id === 'string') zones.set(id, vtz)
  }

  const events = out.getAllSubcomponents('vevent')
  const uid = events[0]?.getFirstPropertyValue('uid')
  const srcEvents = src.getAllSubcomponents('vevent').filter((e) => e.getFirstPropertyValue('uid') === uid)
  const anchorId = srcEvents.find((e) => !e.hasProperty('recurrence-id'))?.getFirstProperty('dtstart')?.getParameter('tzid')
  const anchor =
    typeof anchorId === 'string' && anchorId === options.tzid && zones.has(anchorId)
      ? ICAL.Timezone.fromData({ component: zones.get(anchorId), tzid: anchorId })
      : undefined

  for (const ev of events) {
    const counterpart = srcEvents.find((s) => sameOccurrence(s, ev))
    if (counterpart) carryOver(ev, counterpart, options)
    if (anchor) reanchor(ev, anchor)
  }

  // Every zone a time now names needs its VTIMEZONE, ahead of the events.
  const named = new Set<string>()
  for (const ev of events) collectZoneIds(ev, named)
  const needed = [...named].filter((id) => zones.has(id))
  if (needed.length > 0) {
    for (const ev of events) out.removeSubcomponent(ev)
    for (const id of needed) out.addSubcomponent(cloneComponent(zones.get(id)!))
    for (const ev of events) out.addSubcomponent(ev)
  }

  return out.toString()
}

function carryOver(ev: ICAL.Component, src: ICAL.Component, options: ServerCopyOptions): void {
  const decided = new Set(ev.getAllProperties().map((p) => p.name))
  for (const prop of src.getAllProperties()) {
    if (OWNED.has(prop.name) || decided.has(prop.name)) continue
    const tiedTo = TIED[prop.name]
    if (tiedTo && textOf(ev, tiedTo) !== textOf(src, tiedTo)) continue
    ev.addProperty(cloneProperty(prop))
  }

  carryGuests(ev, src, Boolean(options.keepAttendees))

  // Scheduling servers tell guests about a change only when SEQUENCE goes up.
  const sequence = (Number(src.getFirstPropertyValue('sequence')) || 0) + (timingOf(ev) === timingOf(src) ? 0 : 1)
  if (sequence > 0) ev.updatePropertyWithValue('sequence', sequence)
  ev.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(), true))

  mergeAlarms(ev, src, options.reminders)
}

function carryGuests(ev: ICAL.Component, src: ICAL.Component, keep: boolean): void {
  const generated = [...ev.getAllProperties('organizer'), ...ev.getAllProperties('attendee')]
  if (generated.length === 0) {
    if (keep) {
      for (const p of [...src.getAllProperties('organizer'), ...src.getAllProperties('attendee')]) {
        ev.addProperty(cloneProperty(p))
      }
    }
    return
  }
  // The generated line has the address, name, role and answer; the server's may
  // also carry RSVP, delegation, a guest count and the like.
  for (const p of generated) {
    const twin = src.getAllProperties(p.name).find((s) => addressOf(s) === addressOf(p))
    if (!twin) continue
    const params = (twin.toJSON() as unknown[])[1] as Record<string, unknown>
    for (const [name, value] of Object.entries(params)) {
      if (OWNED_PARAMS.has(name) || p.getParameter(name) !== undefined) continue
      p.setParameter(name, value as string)
    }
  }
}

/**
 * Each reminder keeps the server's alarm for it when there is one - its sound,
 * its email address - and alarms this app cannot express ride along untouched.
 * A reminder removed here takes its alarm with it.
 */
function mergeAlarms(ev: ICAL.Component, src: ICAL.Component, reminders: readonly EventReminder[] | undefined): void {
  const generated = ev.getAllSubcomponents('valarm')
  const serverAlarms = src.getAllSubcomponents('valarm')
  const result = serverAlarms.filter((a) => !alarmAsReminder(a)).map(cloneComponent)
  const used = new Set<ICAL.Component>()

  for (const r of normalizeReminders(reminders ?? [])) {
    const theirs = serverAlarms.find((a) => !used.has(a) && sameReminder(alarmAsReminder(a), r))
    const ours = theirs ? undefined : generated.find((a) => !used.has(a) && sameReminder(alarmAsReminder(a), r))
    const pick = theirs ?? ours
    if (!pick) continue
    used.add(pick)
    result.push(cloneComponent(pick))
  }

  ev.removeAllSubcomponents('valarm')
  for (const alarm of result) ev.addSubcomponent(alarm)
}

function sameReminder(a: EventReminder | null, b: EventReminder): boolean {
  return Boolean(a) && a!.minutesBefore === b.minutesBefore && (a!.method ?? null) === (b.method ?? null)
}

/** Put the generated UTC times in the zone the server's copy was anchored in. */
function reanchor(ev: ICAL.Component, zone: ICAL.Timezone): void {
  for (const name of TIMING) {
    for (const prop of ev.getAllProperties(name)) {
      const values = prop.getValues() as unknown[]
      const utc = values.every(
        (v) => v instanceof ICAL.Time && !v.isDate && v.zone === ICAL.Timezone.utcTimezone
      )
      if (!utc || values.length === 0) continue
      const zoned = (values as ICAL.Time[]).map((v) => v.convertToZone(zone))
      if (prop.isMultiValue) prop.setValues(zoned)
      else prop.setValue(zoned[0])
      prop.setParameter('tzid', zone.tzid)
    }
  }
}

function sameOccurrence(a: ICAL.Component, b: ICAL.Component): boolean {
  const ra = a.getFirstPropertyValue('recurrence-id')
  const rb = b.getFirstPropertyValue('recurrence-id')
  if (!ra || !rb) return !ra && !rb
  return instantOf(ra) === instantOf(rb)
}

/** When a start, end or exception date falls, comparable across zones. */
function instantOf(value: unknown): string {
  if (!(value instanceof ICAL.Time)) return String(value)
  if (value.isDate) return value.toString()
  // A zone the file did not define reads as floating, its name left on the
  // undeclared `timezone` field; an IANA name still resolves.
  const tzid = (value as ICAL.Time & { timezone?: string }).timezone
  if (tzid && value.zone?.tzid === 'floating' && IANAZone.isValidZone(tzid)) {
    const { year, month, day, hour, minute, second } = value
    return String(DateTime.fromObject({ year, month, day, hour, minute, second }, { zone: tzid }).toMillis())
  }
  return String(value.toUnixTime() * 1000)
}

/** Start, end, rule and exceptions: what a guest has to be told about when it changes. */
function timingOf(c: ICAL.Component): string {
  const start = c.getFirstPropertyValue('dtstart')
  let end: unknown = c.getFirstPropertyValue('dtend')
  const duration = c.getFirstPropertyValue('duration')
  if (!end && start instanceof ICAL.Time && duration instanceof ICAL.Duration) {
    const e = start.clone()
    e.addDuration(duration)
    end = e
  }
  const exdates = c
    .getAllProperties('exdate')
    .flatMap((p) => p.getValues())
    .map(instantOf)
    .sort()
  return [instantOf(start), instantOf(end), String(c.getFirstPropertyValue('rrule') ?? ''), ...exdates].join('|')
}

function collectZoneIds(c: ICAL.Component, into: Set<string>): void {
  for (const p of c.getAllProperties()) {
    const tzid = p.getParameter('tzid')
    if (typeof tzid === 'string') into.add(tzid)
  }
  for (const sub of c.getAllSubcomponents()) collectZoneIds(sub, into)
}

function textOf(c: ICAL.Component, name: string): string {
  return String(c.getFirstPropertyValue(name) ?? '')
}

function addressOf(p: ICAL.Property): string {
  return String(p.getFirstValue() ?? '')
    .trim()
    .replace(/^mailto:/i, '')
    .toLowerCase()
}

function cloneProperty(p: ICAL.Property): ICAL.Property {
  return new ICAL.Property(structuredClone(p.toJSON()))
}

function cloneComponent(c: ICAL.Component): ICAL.Component {
  return new ICAL.Component(structuredClone(c.toJSON()))
}
