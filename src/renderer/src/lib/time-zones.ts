import { DateTime } from 'luxon'

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
