/**
 * Type-safe IPC channels, payloads, and API signatures for xrncal
 */

import type {
  Calendar,
  CalendarAccount,
  CalendarEvent,
  EventException,
  ExpandedOccurrence,
  CreateEventInput,
  UpdateEventInput,
  MoveEventInput,
  CopyEventInput,
  UpdateRecurringScopeInput,
  DeleteRecurringScopeInput,
  MaterializeLunarInput,
  DetachLunarInput,
  SyncStatus,
  SyncResult,
  SyncConflict
} from './event-model'
import type { SuggestTitlesOptions, TitleSuggestion } from './title-suggestions'
import type { AppSettings } from './settings-contract'

export const IPC_CHANNELS = {
  APP: {
    GET_VERSION: 'xrncal:app:get-version',
    GET_LOCALE: 'xrncal:app:get-locale',
    SET_LOCALE: 'xrncal:app:set-locale',
    GET_PLATFORM: 'xrncal:app:get-platform',
    PICK_BACKGROUND_IMAGE: 'xrncal:app:pick-background-image',
    BACKUP_DATABASE: 'xrncal:app:backup-database'
  },
  SETTINGS: {
    GET_ALL: 'xrncal:settings:get-all',
    GET: 'xrncal:settings:get',
    SET: 'xrncal:settings:set'
  },
  AUTH: {
    CONNECT_GOOGLE: 'xrncal:auth:connect-google',
    DISCONNECT_GOOGLE: 'xrncal:auth:disconnect-google',
    CONNECT_MICROSOFT: 'xrncal:auth:connect-microsoft',
    DISCONNECT_MICROSOFT: 'xrncal:auth:disconnect-microsoft',
    CONNECT_CALDAV: 'xrncal:auth:connect-caldav',
    DISCONNECT_CALDAV: 'xrncal:auth:disconnect-caldav',
    LIST_ACCOUNTS: 'xrncal:auth:list-accounts',
    DETACH_ACCOUNT: 'xrncal:auth:detach-account'
  },
  SYNC: {
    TRIGGER_NOW: 'xrncal:sync:trigger-now',
    GET_STATUS: 'xrncal:sync:get-status',
    /** main -> renderer. The only push channel in the app; everything else is
     *  invoke/handle. Sent after a background sync that actually changed rows. */
    CHANGED: 'xrncal:sync:changed'
  },
  CALENDAR: {
    LIST: 'xrncal:calendar:list',
    CREATE: 'xrncal:calendar:create',
    UPDATE: 'xrncal:calendar:update',
    DELETE: 'xrncal:calendar:delete'
  },
  EVENT: {
    QUERY_RANGE: 'xrncal:event:query-range',
    GET_BY_ID: 'xrncal:event:get-by-id',
    CREATE: 'xrncal:event:create',
    UPDATE: 'xrncal:event:update',
    DELETE: 'xrncal:event:delete',
    MOVE: 'xrncal:event:move',
    COPY: 'xrncal:event:copy',
    UPDATE_SCOPE: 'xrncal:event:update-scope',
    DELETE_SCOPE: 'xrncal:event:delete-scope',
    UPSERT_EXCEPTION: 'xrncal:event:upsert-exception',
    MATERIALIZE_LUNAR: 'xrncal:event:materialize-lunar',
    DETACH_LUNAR: 'xrncal:event:detach-lunar',
    SEARCH: 'xrncal:event:search',
    SUGGEST_TITLES: 'xrncal:event:suggest-titles',
    SHARE_ICS: 'xrncal:event:share-ics',
    LIST_CONFLICTS: 'xrncal:event:list-conflicts',
    RESOLVE_CONFLICT: 'xrncal:event:resolve-conflict'
  },
  ICS: {
    IMPORT: 'xrncal:ics:import',
    EXPORT: 'xrncal:ics:export'
  },
  MINI: {
    OPEN_MAIN: 'xrncal:mini:open-main',
    TOGGLE: 'xrncal:mini:toggle',
    GET_UPCOMING: 'xrncal:mini:get-upcoming',
    SET_ALWAYS_ON_TOP: 'xrncal:mini:set-always-on-top'
  },
  HOLIDAYS: {
    SUBSCRIBE: 'xrncal:holidays:subscribe',
    UNSUBSCRIBE: 'xrncal:holidays:unsubscribe'
  }
} as const

export type AppLocale = 'vi' | 'en'

export interface DetachAccountResult {
  success: boolean
  /** Calendars converted to local ownership. */
  calendarCount: number
  /** Events kept (none are deleted by detaching). */
  eventCount: number
  message?: string
}

export interface BackupResult {
  success: boolean
  /** Absolute path of the snapshot that was written. */
  filePath?: string
  /** Size of the snapshot in bytes. */
  byteSize?: number
  message?: string
}

export interface IcsImportResult {
  success: boolean
  importedCount: number
  errorCount: number
  message?: string
}

export interface ConnectCalDavInput {
  provider: 'nextcloud' | 'icloud' | 'synology' | 'generic'
  serverUrl?: string
  username: string
  password: string
  name?: string
}

export interface XrncalAPI {
  app: {
    getVersion: () => Promise<string>
    getLocale: () => Promise<AppLocale>
    setLocale: (locale: AppLocale) => Promise<boolean>
    getPlatform: () => Promise<string>
    pickBackgroundImage: () => Promise<{ dataUrl: string } | null>
    /** Write a consistent snapshot of the whole database to a file the user picks. */
    backupDatabase: () => Promise<BackupResult>
  }
  settings: {
    getAll: () => Promise<AppSettings>
    get: <K extends keyof AppSettings>(key: K) => Promise<AppSettings[K]>
    set: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<boolean>
  }
  auth: {
    connectGoogle: () => Promise<{ success: boolean; account?: CalendarAccount; message?: string }>
    disconnectGoogle: (accountId: string) => Promise<boolean>
    connectMicrosoft: () => Promise<{ success: boolean; account?: CalendarAccount; message?: string }>
    disconnectMicrosoft: (accountId: string) => Promise<boolean>
    connectCalDav: (input: ConnectCalDavInput) => Promise<{ success: boolean; account?: CalendarAccount; message?: string }>
    disconnectCalDav: (accountId: string) => Promise<boolean>
    listAccounts: () => Promise<CalendarAccount[]>
    /** Keep this account's calendars and events but sever the provider link,
     *  turning them into ordinary local data. */
    detachAccount: (accountId: string) => Promise<DetachAccountResult>
  }
  sync: {
    triggerNow: () => Promise<SyncResult>
    getStatus: () => Promise<SyncStatus>
    /** Fires when a background sync changed the database. Returns an unsubscribe. */
    onChanged: (callback: () => void) => () => void
  }
  calendars: {
    list: () => Promise<Calendar[]>
    create: (data: { name: string; color: string }) => Promise<Calendar>
    update: (id: string, data: Partial<Pick<Calendar, 'name' | 'color' | 'isVisible'>>) => Promise<Calendar>
    delete: (id: string) => Promise<boolean>
  }
  events: {
    queryRange: (calendarIds: string[], startUtc: string, endUtc: string) => Promise<ExpandedOccurrence[]>
    getById: (id: string) => Promise<{ event: CalendarEvent; exceptions: EventException[] } | null>
    create: (input: CreateEventInput) => Promise<CalendarEvent>
    update: (id: string, input: UpdateEventInput) => Promise<CalendarEvent>
    delete: (id: string) => Promise<boolean>
    move: (input: MoveEventInput) => Promise<CalendarEvent>
    copy: (input: CopyEventInput) => Promise<CalendarEvent>
    updateScope: (input: UpdateRecurringScopeInput) => Promise<boolean>
    deleteScope: (input: DeleteRecurringScopeInput) => Promise<boolean>
    upsertException: (exception: Omit<EventException, 'id' | 'createdAt' | 'updatedAt'>) => Promise<EventException>
    materializeLunar: (input: MaterializeLunarInput) => Promise<{ count: number }>
    detachLunar: (input: DetachLunarInput) => Promise<{ count: number }>
    search: (query: string, limit?: number) => Promise<CalendarEvent[]>
    /** Ranked title autocomplete for the event editor, with the calendar each
     *  title normally lives on. */
    suggestTitles: (options: SuggestTitlesOptions) => Promise<TitleSuggestion[]>
    shareIcs: (eventId: string) => Promise<{ success: boolean; filePath?: string; icsContent?: string; message?: string }>
    listConflicts: () => Promise<SyncConflict[]>
    resolveConflict: (eventId: string, resolution: 'keepMine' | 'keepTheirs') => Promise<boolean>
  }
  ics: {
    importIcs: (targetCalendarId: string, icsContent: string) => Promise<IcsImportResult>
    exportIcs: (calendarId: string) => Promise<string>
  },
  mini: {
    openMain: () => Promise<void>
    toggle: () => Promise<void>
    getUpcoming: (limit?: number) => Promise<{ occurrences: ExpandedOccurrence[] }>
    setAlwaysOnTop: (flag: boolean) => Promise<boolean>
  },
  holidays: {
    subscribe: (type: 'vietnam' | 'international') => Promise<{ calendarId: string; count: number }>
    unsubscribe: (type: 'vietnam' | 'international') => Promise<boolean>
  }
}
