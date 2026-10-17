import { DateTime, IANAZone } from 'luxon'

/** Every zone this runtime knows, for the zone pickers. */
export const TIME_ZONE_NAMES: string[] = (() => {
  try {
    return typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  } catch {
    return []
  }
})()

/** "Asia/Ho Chi Minh (GMT+7)", with the offset it has today. */
export function zoneLabel(zone: string): string {
  const now = DateTime.now().setZone(zone)
  const name = zone.replace(/_/g, ' ')
  return now.isValid ? `${name} (${now.toFormat("'GMT'Z")})` : name
}

let optionsCache: { value: string; label: string }[] | null = null

/** Picker options for every zone, built once: a label each is 400 offset lookups. */
export function zoneOptions(): { value: string; label: string }[] {
  optionsCache ??= TIME_ZONE_NAMES.map((zone) => ({ value: zone, label: zoneLabel(zone) }))
  return optionsCache
}

/** The `preferredTimeZones` setting as a list: known zones, in the order chosen, once each. */
export function parseZoneList(stored: string | null | undefined): string[] {
  const zones: string[] = []
  for (const part of (stored ?? '').split(',')) {
    const zone = part.trim()
    if (zone && !zones.includes(zone) && IANAZone.isValidZone(zone)) zones.push(zone)
  }
  return zones
}

export function serializeZoneList(zones: string[]): string {
  return zones.join(',')
}

const canonicalCache = new Map<string, string>()

/** The name the runtime files a zone under, so two spellings of one zone compare equal.
 *  Cached: the editor asks for every zone on each render. */
function canonicalZone(zone: string): string {
  let canonical = canonicalCache.get(zone)
  if (canonical === undefined) {
    try {
      canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone
    } catch {
      canonical = zone
    }
    canonicalCache.set(zone, canonical)
  }
  return canonical
}

/**
 * The event editor's zone list in two parts: the zones in use - the preferred
 * ones, this computer's and the event's own - and then every other zone. With
 * the event's zone always in the first part, the list opens at its top instead
 * of somewhere among 400 entries.
 *
 * One zone spelled two ways (Asia/Ho_Chi_Minh, Asia/Saigon) is listed once, in
 * the event's spelling when it is the event's zone, so the picker still finds
 * the value it holds.
 */
export function zonePickerOptions(
  preferred: string[],
  localZone: string,
  currentZone: string
): { pinned: { value: string; label: string; isLocal: boolean }[]; rest: { value: string; label: string }[] } {
  const byCanonical = new Map<string, string>()
  for (const zone of [...preferred, localZone, currentZone]) {
    if (!zone) continue
    const key = canonicalZone(zone)
    if (!byCanonical.has(key) || zone === currentZone) byCanonical.set(key, zone)
  }
  const localKey = canonicalZone(localZone)
  const pinned = [...byCanonical].map(([key, zone]) => ({
    value: zone,
    label: zoneLabel(zone),
    isLocal: key === localKey
  }))
  const rest = zoneOptions().filter((o) => !byCanonical.has(canonicalZone(o.value)))
  return { pinned, rest }
}
