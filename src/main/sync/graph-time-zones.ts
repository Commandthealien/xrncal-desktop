import { DateTime, IANAZone } from 'luxon'

/**
 * Which time zone name to give Microsoft Graph for an event.
 *
 * Graph documents `timeZone` as a Windows zone name ("SE Asia Standard Time")
 * or one of a fixed list of IANA names, and warns that create and update may not
 * take all of those. Events went out with whatever IANA zone they had -
 * Asia/Ho_Chi_Minh is not on the list. A Windows name is the form Graph is sure
 * to take, and a series needs a real zone (not UTC) to keep its clock time when
 * summer time starts or ends.
 *
 * One zone per Windows name, with the IANA zone CLDR's windowsZones gives it.
 * Any other IANA zone is matched to the first one here that keeps the same
 * clock - the same UTC offset on every day of the coming year - so Asia/Ho_Chi_Minh
 * goes out as SE Asia Standard Time (Asia/Bangkok's) and Europe/Amsterdam as
 * W. Europe Standard Time (Europe/Berlin's).
 */
const WINDOWS_ZONES: readonly (readonly [iana: string, windows: string])[] = [
  ['Etc/UTC', 'UTC'],
  ['Pacific/Honolulu', 'Hawaiian Standard Time'],
  ['America/Anchorage', 'Alaskan Standard Time'],
  ['America/Los_Angeles', 'Pacific Standard Time'],
  ['America/Phoenix', 'US Mountain Standard Time'],
  ['America/Denver', 'Mountain Standard Time'],
  ['America/Chicago', 'Central Standard Time'],
  ['America/Mexico_City', 'Central Standard Time (Mexico)'],
  ['America/Regina', 'Canada Central Standard Time'],
  ['America/Bogota', 'SA Pacific Standard Time'],
  ['America/New_York', 'Eastern Standard Time'],
  ['America/Halifax', 'Atlantic Standard Time'],
  ['America/St_Johns', 'Newfoundland Standard Time'],
  ['America/Sao_Paulo', 'E. South America Standard Time'],
  ['America/Argentina/Buenos_Aires', 'Argentina Standard Time'],
  ['America/Santiago', 'Pacific SA Standard Time'],
  ['Atlantic/Azores', 'Azores Standard Time'],
  ['Europe/London', 'GMT Standard Time'],
  ['Atlantic/Reykjavik', 'Greenwich Standard Time'],
  ['Europe/Berlin', 'W. Europe Standard Time'],
  ['Europe/Budapest', 'Central Europe Standard Time'],
  ['Europe/Paris', 'Romance Standard Time'],
  ['Europe/Warsaw', 'Central European Standard Time'],
  ['Africa/Lagos', 'W. Central Africa Standard Time'],
  ['Europe/Bucharest', 'GTB Standard Time'],
  ['Europe/Helsinki', 'FLE Standard Time'],
  ['Africa/Cairo', 'Egypt Standard Time'],
  ['Africa/Johannesburg', 'South Africa Standard Time'],
  ['Europe/Istanbul', 'Turkey Standard Time'],
  ['Asia/Jerusalem', 'Israel Standard Time'],
  ['Asia/Riyadh', 'Arab Standard Time'],
  ['Europe/Moscow', 'Russian Standard Time'],
  ['Africa/Nairobi', 'E. Africa Standard Time'],
  ['Asia/Tehran', 'Iran Standard Time'],
  ['Asia/Dubai', 'Arabian Standard Time'],
  ['Asia/Kabul', 'Afghanistan Standard Time'],
  ['Asia/Karachi', 'Pakistan Standard Time'],
  ['Asia/Kolkata', 'India Standard Time'],
  ['Asia/Kathmandu', 'Nepal Standard Time'],
  ['Asia/Dhaka', 'Bangladesh Standard Time'],
  ['Asia/Bangkok', 'SE Asia Standard Time'],
  ['Asia/Shanghai', 'China Standard Time'],
  ['Asia/Singapore', 'Singapore Standard Time'],
  ['Australia/Perth', 'W. Australia Standard Time'],
  ['Asia/Taipei', 'Taipei Standard Time'],
  ['Asia/Tokyo', 'Tokyo Standard Time'],
  ['Asia/Seoul', 'Korea Standard Time'],
  ['Australia/Adelaide', 'Cen. Australia Standard Time'],
  ['Australia/Darwin', 'AUS Central Standard Time'],
  ['Australia/Brisbane', 'E. Australia Standard Time'],
  ['Australia/Sydney', 'AUS Eastern Standard Time'],
  ['Australia/Hobart', 'Tasmania Standard Time'],
  ['Pacific/Port_Moresby', 'West Pacific Standard Time'],
  ['Pacific/Auckland', 'New Zealand Standard Time'],
  ['Pacific/Fiji', 'Fiji Standard Time'],
  ['Pacific/Tongatapu', 'Tonga Standard Time']
]

const SAMPLE_DAYS = 366

const windowsCache = new Map<string, string | null>()

/** Whether two zones have the same UTC offset at noon on each day of the coming year. */
function sameClock(a: string, b: string): boolean {
  const start = DateTime.utc().startOf('day').plus({ hours: 12 })
  for (let day = 0; day < SAMPLE_DAYS; day++) {
    const at = start.plus({ days: day })
    if (at.setZone(a).offset !== at.setZone(b).offset) return false
  }
  return true
}

/** The Windows zone name that keeps the same clock as `tzid`, or null for none known. */
export function windowsZoneFor(tzid: string | undefined): string | null {
  if (!tzid || !IANAZone.isValidZone(tzid)) return null
  const cached = windowsCache.get(tzid)
  if (cached !== undefined) return cached

  const found =
    WINDOWS_ZONES.find(([iana]) => iana === tzid)?.[1] ??
    WINDOWS_ZONES.find(([iana]) => sameClock(iana, tzid))?.[1] ??
    null
  windowsCache.set(tzid, found)
  return found
}

/**
 * The IANA zone for a zone name Graph reports (`originalStartTimeZone`): a
 * Windows name from the table above, or an IANA name as it is. Null for
 * anything else, such as "tzone://Microsoft/Custom".
 */
export function ianaZoneFor(name: string | undefined): string | null {
  if (!name) return null
  const windows = WINDOWS_ZONES.find(([, w]) => w === name)
  if (windows) return windows[0]
  return IANAZone.isValidZone(name) ? name : null
}
