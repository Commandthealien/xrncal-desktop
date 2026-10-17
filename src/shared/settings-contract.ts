/**
 * Application Settings Interface & Defaults
 */

export interface AppSettings {
  locale: 'en' | 'vi'
  showLunar: boolean
  showWeekNumbers: boolean
  showMiniCalendar: boolean
  firstDayOfWeek: number // 0 = Sunday, 1 = Monday (default)
  timeFormat: '12h' | '24h'
  theme: 'system' | 'dark' | 'light'
  themeAccent?: string
  themeCustomBg?: string
  themeOverlayOpacity?: number
  themeBlur?: number
  /** Taskbar-style auto-hide for the top app header (menu/nav/search/view bar). */
  autoHideHeader: boolean
  /** Hour the Day/Week timed grid is scrolled to by default (0-23). */
  dayStartHour: number
  /** Row height of one hour in the Day/Week timed grid. */
  hourBlockSize: 'small' | 'medium' | 'large'
  /** IANA zone name (e.g. "America/New_York") shown as a second hour gutter in
   *  Day/Week view - empty means disabled. */
  secondaryTimezone: string
  /** IANA zones the event editor's zone picker lists first, comma-separated
   *  ("Asia/Ho_Chi_Minh,Europe/London") - a setting holds only plain values.
   *  Empty: the picker leads with this computer's zone alone. */
  preferredTimeZones: string
  /** Grid step that dragging, dropping and edge-resizing snap to, in minutes.
   *  Also the shortest event a resize can produce - a 15-minute floor under a
   *  one-hour tick would let a drag land off the grid it just snapped to. */
  dragSnapMinutes: 15 | 30 | 60
  /** Title suggestions always show the calendar's colour dot; this adds its name
   *  next to it. Off keeps the list to one line per suggestion. */
  suggestionShowCalendarName: boolean
  /** Minutes before a timed event that it rings when it names no reminders of
   *  its own (and its calendar publishes no default). null: none. */
  defaultReminderMinutes: number | null
  /** The same for all-day events, counted back from midnight on the day, so
   *  900 is "the day before at 09:00". null: none. */
  defaultAllDayReminderMinutes: number | null
  /** Look for new releases on GitHub and install them on quit. The only
   *  request the app makes that is not to a calendar provider. */
  checkForUpdates: boolean
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  locale: 'en',
  showLunar: true,
  showWeekNumbers: true,
  // The sidebar holds the calendar list now, not just the mini calendar, so it
  // starts shown. Only the default moves: a user who switched it off stays off.
  showMiniCalendar: true,
  firstDayOfWeek: 1, // ISO standard Monday
  timeFormat: '24h',
  theme: 'dark',
  themeAccent: '#5865f2',
  themeCustomBg: '',
  themeOverlayOpacity: 0.8,
  themeBlur: 8,
  autoHideHeader: true,
  dayStartHour: 7,
  hourBlockSize: 'medium',
  secondaryTimezone: '',
  preferredTimeZones: '',
  dragSnapMinutes: 15,
  suggestionShowCalendarName: true,
  // Ten minutes is what every timed event rang with before reminders existed.
  defaultReminderMinutes: 10,
  defaultAllDayReminderMinutes: null,
  checkForUpdates: true
}

/**
 * Whether `key` names a setting. The `settings` table also holds rows that are
 * not settings - the encrypted `token:<accountId>` credentials - and the IPC
 * handed those to the renderer and let it overwrite any key at all.
 */
export function isAppSettingKey(key: unknown): key is keyof AppSettings {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(DEFAULT_APP_SETTINGS, key)
}
