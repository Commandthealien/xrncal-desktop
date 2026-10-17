# xrncal — Project Roadmap

**Last updated:** 2026-10-11  
**Current version:** 0.1.0

---

## Current State

All 10 planned phases are **complete**. The codebase ships R1 + R2 + R3 + Stretch capabilities in version 0.1.0.

| Phase | Name | Status |
|-------|------|--------|
| 1 | Scaffold Electron + Vite + React + TypeScript | ✅ Complete |
| 2 | Domain, SQLite, ICS, Recurrence | ✅ Complete |
| 3 | Custom Views, Lunar, Week Numbers | ✅ Complete |
| 4 | Event Editor and Drag-and-Drop | ✅ Complete |
| 5 | Google Sync, Offline, Notifications | ✅ Complete — **R1 gate** |
| 6 | Microsoft Graph Adapter | ✅ Complete |
| 7 | CalDAV Adapter and Onboarding | ✅ Complete |
| 8 | Invite, Share, Search, Filters | ✅ Complete — **R2 gate** |
| 9 | Mini Window, Local Tasks, Deep Theme | ✅ Complete — **R3 gate** |
| 10 | Stretch: A11y, Adaptive Sync, Holidays | ✅ Complete |

---

## R1 Features (Complete)

- ✅ Five calendar views: Day, Week, Month, Year, List
- ✅ Full event editor on blank click (not a title-only popover)
- ✅ Create / edit / delete events with full field set
- ✅ Recurring event create + edit (this / this-and-future / all)
- ✅ Drag-and-drop with Move / Copy / Cancel popover
- ✅ Week numbers (ISO, toggle in settings)
- ✅ Vietnamese lunar secondary labels (toggle)
- ✅ Google Calendar OAuth + two-way sync
- ✅ Offline: browse and mutate local cache; sync when online
- ✅ OS notifications for reminders (Windows + Linux)
- ✅ Show/hide calendars; color per calendar; optional color per event
- ✅ Light / dark / system theme
- ✅ UI language vi + en

## R2 Features (Complete)

- ✅ Microsoft Graph (Outlook.com / Microsoft 365) two-way sync
- ✅ CalDAV: Nextcloud, Synology, generic URL — discovery + two-way sync
- ✅ Guest lists sync with all three providers; reply Yes / Maybe / No to invitations (added 2026-10)
- ✅ Share appointment: export `.ics` + OS open-with flow
- ✅ Full-text search across cached events (FTS5)
- ✅ Birthday calendars via provider (when exposed)
- ✅ Filter events by calendar color

## R3 Features (Complete)

- ✅ Mini window: always-on-top tray companion with upcoming events
- ~~Local tasks~~ — built, then removed (migration 005); not planned to return
- ✅ Deep theme: accent colors, custom wallpaper, blur + darkness overlay

## Stretch Features (Complete)

- ✅ Global keyboard shortcuts (T=today, 1–5=views, N/C=new, /=search, ?=help)
- ✅ Adaptive sync polling (20s focused / 5m blurred)
- ✅ Vietnamese and International holiday calendar subscriptions
- ✅ Copy single recurring instance (separate from full-series copy)

## Added after 0.1.0 (2026-10)

- ✅ **Reminders:** a list per event, defaults for timed and all-day events, synced with Google
  (`reminders`), Graph (one reminder) and CalDAV (`VALARM`); all-day reminders such as "the day
  before at 09:00", which new lunar anniversaries start with; an in-app list to snooze, join the
  meeting or dismiss. Declined invitations and read-only calendars do not ring by default.
- ✅ **Invitation replies:** guest lists pulled and pushed for all providers; Yes / Maybe / No
  delivered through Google's guest list, Graph's accept/decline actions, or CalDAV PARTSTAT.
- ✅ **Subscriptions by link:** read-only calendars from an `.ics` / `webcal://` feed, refreshed
  every six hours.
- ✅ **Undo:** `Ctrl+Z` for moves, resizes, copies and deletes; an Undo button on the delete toast.
- ✅ **Releases and updates:** tag-triggered release workflow (draft GitHub release, Windows NSIS +
  Linux AppImage) and in-app updates via `electron-updater`, behind a setting.
- ✅ **Fixes:** Microsoft sync now removes events deleted in Outlook and skips unchanged rows;
  holiday calendars extend themselves as years pass; clicking a reminder opens the main window
  even after it was closed to the tray; editing an event opened from the grid no longer deletes
  its guests; CalDAV pulls keep meeting links and colours.
- ✅ **Search that works:** the full-text index never matched (it was built contentless) and slowed
  every write; rebuilt, it now also finds words without their diacritics ("hop" finds "họp").
- ✅ **Sync robustness:** CalDAV pulls download only the events whose etag changed; an edit here
  keeps what other CalDAV clients stored on the event; each account shows why its sync failed;
  a stalled response body can no longer stop sync until restart.
- ✅ **Outlook times:** clock time in a zone Graph accepts, the organiser's zone kept on pull, and
  full notes instead of the 255-character preview.
- ✅ **Editor:** an event's own time zone and colour; all-day dates no longer move a day west of UTC.
- ✅ **Reminders:** snoozes and cards on screen survive a restart.
- ✅ **UI tests and signing:** Playwright drives the built app in CI; the release workflow signs the
  Windows installer once a certificate (Azure Trusted Signing or `.pfx`) is configured.

---

## Open Items / Known Gaps

These are non-blocking items that remain for post-0.1.0:

### Must Validate Before "Daily Driver" Gate

- [ ] **Live Google OAuth round-trip** — Requires a real Google Cloud OAuth Desktop client ID. The sync engine is complete but must be tested end-to-end with a real account before R1 is declared production-ready.
- [ ] **Linux `safeStorage` validation** — Verify fail-closed behavior on a headless Ubuntu environment where D-Bus / libsecret is unavailable.

### Known Deferrals (URD-tracked)

- [ ] **iCloud CalDAV** — Best-effort in R2. Known Apple non-standard behavior. Nextcloud/generic are the R2 Must targets.
- [ ] **Fedora / `.deb` packaging** — Deferred post-R1. Ubuntu LTS + AppImage is the only validated Linux package.
- [ ] **Linux distro matrix** — Full xdg desktop integration tested on Ubuntu LTS only.

### Open Architecture Questions (URD §15)

- [ ] Google OAuth client: published app vs testing-mode quota.
- [ ] Whether R1 Google sync includes Google Tasks, birthdays, and holidays calendars as read-only.
- [ ] Recurring copy: keep "whole series" as permanent behavior, or add "this instance only" promotion in R2 (already implemented as stretch).

---

## Post-0.1.0 Candidates

The following ideas are outside the current URD scope and require a URD change before planning:

| Idea | Notes |
|------|-------|
| macOS support | Out of scope (URD §6). Electron supports it; requires separate packager config and safeStorage behavior check. |
| Near-real-time sync (push) | Google / Graph push notifications via webhooks; currently polling-only. |
| Multi-year cache expansion | Currently pulls a bounded window. Full history requires a configurable cache depth. |
| `.deb` / Fedora RPM packaging | Follow-on after AppImage is validated. |
| CalDAV self-signed TLS UI | Planned in the URD, never implemented: self-signed servers are simply refused by Node's TLS. |
| Natural-language quick add | "Họp 3pm thứ 6", "giỗ ông 12/8 âm lịch" - deferred. |
| Code signing | The release workflow signs once a certificate is configured (`docs/deployment-guide.md`); none is yet, so SmartScreen still warns. |
| Per-occurrence reminders | Reminders belong to the series; a `this`-scoped reminder change applies to all occurrences. |
| Moving an Outlook event between calendars | Graph has no move endpoint and the push does not recreate the event, so it returns to its original calendar at the next full listing (it used to leave a duplicate). |
| Graph occurrence overrides | The `/events` listing carries series masters only, so an occurrence moved in Outlook keeps its series time here. |

---

## Versioning Plan

| Version | Milestone |
|---------|-----------|
| 0.1.0 | All 10 phases complete. R1+R2+R3+Stretch in codebase. |
| 0.2.0 | First published release from the release workflow (reminders, replies, subscriptions, undo, auto-update), live Google OAuth tested. "Daily driver" gate. |
| 0.3.0 | iCloud CalDAV best-effort validated. Fedora AppImage. |
| 1.0.0 | Stable release after daily driver validation on both OS targets. |
