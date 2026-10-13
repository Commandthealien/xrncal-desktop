# xrncal — Codebase Summary

**Last updated:** 2026-10-11  
**Version:** 0.1.0  
**Build status:** 539 tests in 62 files passing, 0 TypeScript errors, 0 lint errors, clean production build. CI (`.github/workflows/ci.yml`) runs lint + typecheck + tests + build on every push and PR; a `v*` tag runs `.github/workflows/release.yml`.

---

## Directory Map

```
xrncal/
├── src/
│   ├── main/                    # Electron main process
│   │   ├── index.ts             # App lifecycle, window creation, single-instance lock
│   │   ├── ipc.ts               # Central IPC handler registration
│   │   ├── ipc/                 # IPC handler modules
│   │   │   ├── auth-sync-ipc.ts # OAuth connect/disconnect + sync trigger handlers
│   │   │   ├── calendar-ipc.ts  # Calendar + event (incl. reply, restore) + ICS IPC handlers
│   │   │   ├── holiday-ipc.ts   # Holiday subscription IPC handlers
│   │   │   ├── reminders-ipc.ts # Active reminders: list, dismiss, snooze (registered from index.ts)
│   │   │   ├── settings-ipc.ts  # Settings get/set IPC handlers
│   │   │   └── subscriptions-ipc.ts # Calendars subscribed to by .ics / webcal link
│   │   ├── db/                  # Database layer
│   │   │   ├── database.ts      # initDatabase, runMigrations (inline 001-021), seedDefaultData
│   │   │   ├── sqlite-driver.ts # ISqliteDatabase abstraction (node:sqlite / better-sqlite3)
│   │   │   ├── backup.ts        # VACUUM INTO snapshot for Settings → Back up database
│   │   │   ├── migrations/      # Reference copies of the inline migrations (001-021)
│   │   │   └── repos/           # calendars, events, settings, sync-state, detach-account
│   │   ├── holidays/            # Generated holiday calendars, extended at startup
│   │   ├── subscriptions/       # ics-subscription.ts: fetch, store and refresh feeds
│   │   ├── sync/                # Provider sync engines
│   │   │   ├── sync-worker.ts   # SyncWorker: poll loop, adaptive interval (20s focus / 5m blur)
│   │   │   ├── google-sync-engine.ts    # Google Calendar API v3 two-way sync
│   │   │   ├── google-event-mapper.ts   # Google event JSON ↔ canonical CalendarEvent
│   │   │   ├── microsoft-sync-engine.ts # Microsoft Graph two-way sync
│   │   │   ├── microsoft-event-mapper.ts # Graph event ↔ canonical CalendarEvent
│   │   │   ├── graph-recurrence-map.ts  # Graph recurrence patterns ↔ RFC 5545 RRULE
│   │   │   ├── caldav-sync-engine.ts    # CalDAV tsdav two-way sync
│   │   │   ├── caldav-adapter.ts        # CalDAV calendar discovery + adapter
│   │   │   └── caldav-discover.ts       # RFC 6764 DNS/well-known server discovery
│   │   ├── ics/                 # ICS import/export
│   │   │   ├── parse-ics.ts     # ical.js parser → canonical events
│   │   │   └── write-ics.ts     # Canonical events → RFC 5545 ICS file
│   │   ├── oauth/               # OAuth flows
│   │   ├── notifications/
│   │   │   └── reminder-scheduler.ts # Rings reminders; keeps the active list snooze/join act on
│   │   ├── mini-window.ts       # Frameless companion mini window
│   │   ├── tray.ts              # System tray icon and context menu
│   │   ├── updater.ts           # electron-updater against GitHub releases (packaged builds only)
│   │   └── secure-store.ts      # safeStorage wrapper for OAuth tokens and CalDAV credentials
│   ├── preload/
│   │   ├── index.ts             # contextBridge: exposes window.xrncal API (XrncalAPI typed)
│   │   └── index.d.ts           # TypeScript declarations for preload
│   ├── renderer/
│   │   └── src/
│   │       ├── App.tsx          # Root component: shell, routing, global keyboard listener
│   │       ├── main.tsx         # Entry: dual-mode router (App vs MiniApp via #mini hash)
│   │       ├── views/           # Calendar view components
│   │       │   ├── DayView.tsx
│   │       │   ├── WeekView.tsx
│   │       │   ├── MonthView.tsx
│   │       │   ├── YearView.tsx
│   │       │   └── ListView.tsx
│   │       ├── components/      # UI components
│   │       │   ├── shell/       # AppHeader.tsx, AppSidebar.tsx (mini calendar + SidebarCalendars.tsx), ViewSwitcher.tsx
│   │       │   ├── accounts/    # AccountsDialog.tsx (page stack), AccountViews.tsx, AddAccountViews.tsx, CalendarToggle.tsx, ProviderMark.tsx
│   │       │   ├── ui/          # Primitives: TextInput, TextArea, NumberInput, CustomSelect, DatePicker, TimePicker, ToggleSwitch, Checkbox, FormRow, toast, index.ts
│   │       │   ├── MiniCalendar.tsx
│   │       │   ├── EventPill.tsx
│   │       │   ├── TimedEventBlock.tsx
│   │       │   ├── HourGutter.tsx       # Merged primary + secondary clock gutter
│   │       │   ├── DayPeekPopover.tsx   # Month-view day peek
│   │       │   ├── SettingsPanel.tsx    # Right-side settings drawer (root list + one level)
│   │       │   ├── AppearanceSettings.tsx
│   │       │   ├── LunarLabel.tsx
│   │       │   ├── WeekNumber.tsx
│   │       │   ├── ResizeTimeTooltip.tsx
│   │       │   ├── SyncConflictsModal.tsx
│   │       │   ├── ReminderStack.tsx    # Rung reminders: join, open, snooze, dismiss
│   │       │   ├── HolidayCalendarToggle.tsx   # Used by the accounts dialog's holidays page
│   │       │   ├── KeyboardShortcutsModal.tsx
│   │       │   ├── SearchPaletteModal.tsx
│   │       │   └── ErrorBoundary.tsx
│   │       ├── editor/          # EventEditorDialog, RecurringScopeDialog, TitleSuggestInput, ReminderListField
│   │       ├── dnd/             # Drag and drop: use-event-dnd.ts, drop-target.ts, DropActionPopover.tsx
│   │       ├── mini/            # MiniApp.tsx (companion window renderer)
│   │       ├── hooks/           # use-theme.ts, use-visible-range.ts, use-wheel-navigation.ts
│   │       ├── lib/             # account-display, roving-index, wheel-navigation, reminder-labels
│   │       ├── i18n/            # i18next setup, vi/en translation strings
│   │       └── styles/          # index.css: design tokens, Tailwind layers
│   └── shared/                  # Shared contracts (used by both main and renderer)
│       ├── event-model.ts       # CalendarAccount, Calendar, CalendarEvent, ExpandedOccurrence, etc.
│       ├── reminders.ts         # Reminder lists: defaults, due times, wording, per-provider merge
│       ├── keyboard-nav.ts      # Keyboard cursor, nudge and resize maths
│       ├── all-day.ts           # Floating-date vs instant: inclusive/exclusive ends, day keys
│       ├── occurrence-order.ts  # Within-day ordering (all-day first, then by time)
│       ├── title-suggestions.ts # Ranking for the event-title autocomplete
│       ├── expand-occurrences.ts # RRULE + exception expansion
│       ├── lunar-vietnam.ts     # Vietnamese lunar calendar conversion
│       ├── timed-event-segments.ts # Splits multi-day timed occurrences per day
│       ├── day-highlight.ts     # Today / selection highlight rules
│       ├── holiday-calendars.ts # Built-in holiday subscription definitions
│       ├── time-format.ts       # 12h/24h formatting helpers
│       ├── settings-contract.ts # Settings keys and value types
│       ├── theme-mode.ts        # ThemeMode enum
│       ├── mini-calendar-grid.ts # Grid computation utilities
│       ├── visible-range.ts     # Visible date range helpers
│       └── ipc-contract.ts      # IPC_CHANNELS constants and XrncalAPI interface
├── tests/                       # Vitest unit tests (539 tests / 62 files)
│   └── stubs/electron.ts        # `electron` module stub for main-process tests
└── docs/
    ├── urd.md                   # User Requirements Document
    ├── design-guidelines.md     # Visual language and design tokens
    ├── project-overview-pdr.md  # Product overview + decision record (this plane)
    ├── codebase-summary.md      # This file
    ├── system-architecture.md
    └── code-standards.md
```

---

## Module Responsibilities

### `src/main` (Electron Main Process)

| File/Dir | Responsibility |
|----------|----------------|
| `index.ts` | App lifecycle, single-instance lock, window creation, focus/blur → adaptive sync |
| `ipc.ts` | Registers all IPC handler groups on startup |
| `ipc/` | Handler modules: auth+sync, calendar+event+ICS, settings, holidays, subscriptions, reminders |
| `db/database.ts` | `initDatabase()`, `runMigrations()`, `seedDefaultData()` |
| `db/sqlite-driver.ts` | `ISqliteDatabase` abstraction over `node:sqlite` / `better-sqlite3` |
| `db/repos/` | Repository pattern: CalendarsRepo, EventsRepo, SettingsRepo, SyncStateRepo, detachAccount |
| `sync/sync-worker.ts` | Poll loop; 20s interval on window focus, 5m when blurred; also refreshes due subscriptions |
| `sync/*-sync-engine.ts` | Google, Microsoft Graph, CalDAV two-way sync: events, reminders, guest lists, replies |
| `subscriptions/ics-subscription.ts` | Read-only calendars fed from an .ics / webcal link, refreshed every 6 h |
| `holidays/holiday-subscription.ts` | Generated holiday calendars; `refreshHolidayCalendars()` extends them at startup |
| `updater.ts` | Downloads new releases in the background and installs them on quit; follows `checkForUpdates` |
| `ics/` | ICS file import (ical.js) and export (RFC 5545 writer) |
| `secure-store.ts` | `safeStorage` wrapper; fail-closed on Linux if keyring unavailable |
| `mini-window.ts` | Frameless 380×520 companion window; always-on-top toggle |
| `tray.ts` | System tray icon, context menu, single-click toggle |
| `notifications/reminder-scheduler.ts` | Rings each occurrence's reminders (per-event list, else the defaults); keeps rung reminders for snooze / join until dismissed |

### `src/preload`

`index.ts` exposes `window.xrncal` via `contextBridge`. Sandbox + contextIsolation enabled. Renderer has no direct Node.js access.

**`window.xrncal` API namespaces:**

| Namespace | Methods |
|-----------|---------|
| `app` | `getVersion`, `getLocale`, `setLocale`, `getPlatform`, `pickBackgroundImage`, `backupDatabase` |
| `settings` | `getAll`, `get`, `set` |
| `auth` | `connectGoogle`, `disconnectGoogle`, `connectMicrosoft`, `disconnectMicrosoft`, `connectCalDav`, `disconnectCalDav`, `listAccounts`, `detachAccount` |
| `sync` | `triggerNow`, `getStatus`, `onChanged` |
| `reminders` | `listActive`, `dismiss`, `snooze`, `onChanged` |
| `calendars` | `list`, `create`, `update`, `delete` |
| `events` | `queryRange`, `getById`, `create`, `update`, `delete`, `move`, `copy`, `updateScope`, `deleteScope`, `upsertException`, `materializeLunar`, `detachLunar`, `search`, `suggestTitles`, `shareIcs`, `listConflicts`, `resolveConflict`, `respond`, `restore` |
| `ics` | `importIcs`, `exportIcs` |
| `mini` | `openMain`, `toggle`, `getUpcoming`, `setAlwaysOnTop` |
| `holidays` | `subscribe`, `unsubscribe` |
| `subscriptions` | `add`, `refresh` |

### `src/renderer` (React App)

Entry: `main.tsx` detects `#mini` URL hash to route to `MiniApp` (companion widget) vs `App` (main calendar).

**`App.tsx`** orchestrates:
- Active view routing (Day/Week/Month/Year/List)
- Global keyboard shortcuts listener — the app is fully drivable without a mouse: a selection
  cursor over the on-screen occurrences (`↑`/`↓`, `Enter`, `Del`, `Shift`/`Alt`+arrows to move or
  resize), period navigation (`T`, `←`/`K`, `→`/`J`), views (`1`–`5`, `D`/`W`/`M`/`Y`/`L`) and
  actions (`N`/`C`, `Ctrl+K`//, `Ctrl+B`, `R`, `,`, `?`/`F1`, `Esc`). Cursor maths lives in
  `src/shared/keyboard-nav.ts`; the ring is `.gc-event.is-key-selected`.
- An undo stack: every move, resize, copy and delete pushes its inverse, and `Ctrl+Z` runs the
  latest. A delete is undone from a snapshot taken before it (`events.restore`), because a synced
  deletion is pushed within seconds and the row is gone after that.
- The event editor is keyboard-complete too: `Ctrl+Enter` saves, `Ctrl+⌫` deletes, `Enter` in the
  title saves outright, and `CustomSelect` / `DatePicker` / `TimePicker` each drive their portalled
  popover with a roving index (`src/renderer/src/lib/roving-index.ts`, `.gc-option-active`) because
  a portal at the end of `<body>` can never be tabbed into. Keyboard focus is `.gc-focus-ring`.
- Theme background layer and the `SettingsPanel` drawer
- `ReminderStack`, the in-app half of reminders (Linux notifications cannot carry buttons)

**Views:** All five calendar layouts are custom React components with no third-party calendar shell.

**DnD:** `use-event-dnd.ts` + `drop-target.ts` implement pointer-based drag.
Drops snap to the `dragSnapMinutes` setting (15 / 30 / 60), which is passed in
rather than read from context - `useEventDnD` is called from App's own body,
above the provider App renders. `resolveDropRange` makes the one decision a drop
has to make: the all-day lane makes an occurrence all-day, the hourly grid makes
it timed at the cursor for an hour, a plain day cell keeps its time and changes
the date, and anything else shifts by the drag delta with its span intact. The
start is always snapped onto the grid afterwards, because the delta is measured
from the dragged slice and would otherwise carry the event's own odd minutes
through. A timed occurrence that stays timed is the only ambiguous drop, so it is the only
one that stops to ask: `DropActionPopover` offers Move / Copy (and, for a series,
Copy this one / Copy whole series). Crossing the lanes is a conversion the gesture
already performed, and an all-day event landing on another day is an unambiguous
move, so both go straight through. Alt-drag copies outright. Every copy except
"whole series" is bare - title, calendar and length only.

Edge resize (`use-event-resize.ts`) is **vertical only** - north and south change
the time on the same snap grid. East/west used to stretch an event across whole
days; it was easy to catch while aiming to drag a block, turned one-hour events
into 25-hour ones, and was removed. Multi-day timed occurrences are still split
for display in `timed-event-segments.ts`.

### `src/shared`

TypeScript contracts shared between main and renderer via `@shared/*` path alias. Contains no runtime DOM or Node.js dependencies.

Key types: `CalendarEvent`, `ExpandedOccurrence`, `Calendar`, `CalendarAccount`, `EventReminder`, `Attendee`, `ActiveReminder`, `XrncalAPI`, `IPC_CHANNELS`.

---

## Database Schema (17 migrations)

Applied by `runMigrations()` from the inline constants in `src/main/db/database.ts`; the files in
`src/main/db/migrations/` are reference copies.

| # | What it added or fixed |
|---|---|
| 001 | `accounts`, `calendars`, `events`, `event_exceptions`, `sync_state`, `settings` |
| 002 | `attendees` rows and the `events_fts` FTS5 index (kept by triggers) |
| 003 / 005 | Local `tasks`, later dropped |
| 004 | `lunar_rule` and `lunar_source_event_id` for lunar anniversaries |
| 006 | `has_conflict` for 412s awaiting the user |
| 007 | Push tracking on `event_exceptions` (`dirty`, `etag`, `provider_instance_id`) |
| 008 | `sync_state` rebuilt keyed on `calendar_id` |
| 009 | UNIQUE index on `(master_event_id, original_start_utc)` |
| 010 / 011 | All-day end repair; per-occurrence `all_day` |
| 012 | `color_is_custom`: a picked colour survives sync |
| 013 | `moved_from_calendar_id` for provider-side moves |
| 014 | `provider_event_id`: the local `id` never changes |
| 015 | `events.reminders`, `calendars.default_reminders` (JSON; NULL = the default) |
| 016 | `attendees.is_self`, `events.rsvp_pending`, `events.attendees_synced` |
| 017 | `calendars.subscription_url`, `subscription_refreshed_at` |
| 018 | `reminder_log` (reminders that rang survive a restart), `attendees.role` (optional guests, rooms) |
| 019 | `events_fts` rebuilt as an external-content index by rowid: 002's contentless one never matched and scanned itself on every update |
| 020 | `event_sources`: the CalDAV server's copy of each event, so an edit here keeps what other clients stored (`merge-ics.ts`) |
| 021 | `reminder_state`: reminder cards on screen and snoozes survive a restart |

## Test Coverage

Tests live in `tests/`, one file per module or behaviour - `ls tests` is the index. The ones
added with reminders, invitation replies, subscriptions and undo:

```
tests/
├── reminders.test.ts              # Reminder lists: defaults, due times, wording, provider merge
├── reminder-sync.test.ts          # Reminders through the Google, Graph and iCalendar mappings
├── reminder-scheduler.test.ts     # What rings when; snooze, dismiss, all-day, notification click
├── invite-replies.test.ts         # Guest lists from each provider, replies, and no blind pushes
├── graph-pull.test.ts             # Microsoft: etag skip, prune on full listing, incremental filter
├── ics-subscription.test.ts       # Feeds: webcal, stable ids, unchanged-feed skip, due refresh
├── holiday-refresh.test.ts        # Holiday calendars extended as the years pass
└── undo-restore.test.ts           # Bringing a deleted event back, before and after its push
```

**Total: 539 tests across 62 files. All passing.**

Main-process tests run in plain Node; the `electron` module is aliased to
`tests/stubs/electron.ts` in `vitest.config.ts` so they do not need the Electron
binary. Renderer-touching tests (`drop-target`, `resize-math`, `ui-components` and the others
listed in `tsconfig.web.json`'s `include`) are typechecked there; all others under
`tsconfig.node.json`.

---

## Key Dependencies

| Package | Role |
|---------|------|
| `electron` 35+ | Cross-platform desktop shell |
| `electron-vite` | Build + dev server |
| `react` 19 | Renderer UI |
| `tailwindcss` 4 | Styling |
| `luxon` | Date/time + timezone handling |
| `rrule` | RFC 5545 recurrence expansion |
| `ical.js` | ICS import/export |
| `i18next` / `react-i18next` | vi/en internationalization |
| `lucide-react` | Icon set |
| `electron-updater` | In-app updates from GitHub releases |
| `electron-builder` | Windows NSIS / Linux AppImage packaging and release upload |
| `vitest` | Unit test runner |
