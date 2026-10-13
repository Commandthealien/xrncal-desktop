# xrncal — Deployment Guide

**Last updated:** 2026-08-31

---

## Prerequisites

- Node.js 23.4+ (24 recommended, as CI uses) - the database tests need the built-in `node:sqlite`
- npm 10+
- Git

---

## Development Setup

```bash
# Clone the repository
git clone https://github.com/Xernnn/xrncal-desktop
cd xrncal-desktop

# Install dependencies
npm install

# Start the Electron dev app (hot-reload via electron-vite)
npm run dev
```

The dev server starts the Electron app with Vite HMR for the renderer process.

---

## Type Checking

```bash
# Check both main process and renderer
npm run typecheck

# Check individually
npm run typecheck:node   # Main + preload (tsconfig.node.json)
npm run typecheck:web    # Renderer (tsconfig.web.json)
```

---

## Running Tests

```bash
npm run test
# Runs: vitest run (the whole suite, ~610 tests)
```

Test files live in `tests/` at the project root and use `:memory:` SQLite for database tests.
Main-process tests import a stub `electron` module (`tests/stubs/electron.ts`, aliased in
`vitest.config.ts`), so the Electron binary is not required to run them.

### UI tests

```bash
npm run test:e2e
# Runs: npm run build && playwright test
```

`e2e/` drives the built app through Playwright's Electron support: it launches
`out/main/index.js` on a throwaway profile (`XRNCAL_USER_DATA_DIR`, which `src/main/index.ts`
honours before taking the single-instance lock, so a running copy of xrncal is neither touched
nor in the way) with `TZ=Asia/Ho_Chi_Minh`, and checks a fresh start, the settings IPC, search
without diacritics, and an edit in another time zone. These need the real Electron binary and a
display; on a Linux machine without one, run them under `xvfb-run -a`.

---

## Continuous Integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request:

1. `npm ci` (with `ELECTRON_SKIP_BINARY_DOWNLOAD=1` — CI does not package the app)
2. `npm run lint` — ESLint (errors fail; `no-explicit-any` is a warning)
3. `npm run typecheck` — main + renderer
4. `npm run test` — full Vitest suite
5. `npm run build` — production bundle

A second job, `ui`, installs Electron and runs `xvfb-run -a npm run test:e2e`.

---

## Releases and In-App Updates

`.github/workflows/release.yml` runs on a pushed `v*` tag:

1. Checks the tag equals `v` + `package.json`'s `version` (electron-builder names the release
   after `package.json`, so a mismatch would publish under the wrong version).
2. Lint, typecheck and tests.
3. On `windows-latest` and `ubuntu-latest`: `npm run build`, then
   `electron-builder --publish always`, which uploads the NSIS installer, the AppImage and the
   `latest.yml` / `latest-linux.yml` files to a **draft** release (`publish` in
   `electron-builder.yml`, authenticated by the workflow's `GITHUB_TOKEN`).

To ship:

```bash
npm version 0.2.0 --no-git-tag-version   # or edit package.json by hand
git commit -am "chore: release 0.2.0"
git tag v0.2.0 && git push origin main v0.2.0
# then review and publish the draft on GitHub
```

Installed builds check the published releases every six hours (`src/main/updater.ts`), download
a newer one in the background and install it when the app quits. Only packaged builds update, and
on Linux only the AppImage; the **Check for updates** setting turns it off.

### Code signing

Unsigned, the Windows installer makes SmartScreen ask before the first run, and nothing ties an
update to its publisher. The release workflow signs it as soon as one of these is set up in the
repository's **Settings → Secrets and variables → Actions** (until then it builds unsigned):

- **Azure Trusted Signing** (Microsoft's signing service; the usual choice now that new
  certificates come on hardware or cloud keys rather than as files). Create a Trusted Signing
  account and certificate profile, and an app registration with the *Trusted Signing Certificate
  Profile Signer* role. Secrets: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.
  Variables: `AZURE_PUBLISHER_NAME` (the certificate's subject CN), `AZURE_ENDPOINT` (e.g.
  `https://eus.codesigning.azure.net`), `AZURE_CODE_SIGNING_ACCOUNT`, `AZURE_CERTIFICATE_PROFILE`.
- **A `.pfx` certificate**: `WIN_CSC_LINK` (the file, base64-encoded) and `WIN_CSC_KEY_PASSWORD`.

Once releases are signed, electron-updater checks each Windows update against the publisher name
before installing it. The AppImage is not signed.

---

## Building for Production

```bash
npm run build
# Outputs to:
#   out/main/index.js       (Electron main process)
#   out/preload/index.js    (contextBridge preload)
#   out/renderer/           (React static bundle)
```

---

## Packaging

### Windows (NSIS x64 Installer)

```bash
npm run pack:win
# Runs: electron-vite build && electron-builder --win --x64
# Output: dist/*.exe (NSIS installer)
```

Requirements:
- Run on Windows or use a CI Windows runner.
- Unsigned when built locally; see [Code signing](#code-signing) for signed release builds.

### Linux (AppImage x64)

```bash
npm run pack:linux
# Runs: electron-vite build && electron-builder --linux AppImage --x64
# Output: dist/*.AppImage
```

**R1 validated target:** Ubuntu LTS + AppImage x64.

To run the AppImage on Linux:
```bash
chmod +x xrncal-*.AppImage
./xrncal-*.AppImage
```

---

## electron-builder Configuration

See [`electron-builder.yml`](../electron-builder.yml) at the project root. Key settings:

- `appId`: `app.xrncal.desktop`
- `productName`: `xrncal`
- `nsis.oneClick`: false (installer shows options)
- `linux.category`: `Office;Calendar;`
- `linux.target`: AppImage
- `publish`: GitHub, `Xernnn/xrncal-desktop`, as a draft release (see Releases above)

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ELECTRON_RENDERER_URL` | Set automatically by electron-vite in dev mode. Points to the Vite dev server. In production, renderer loads `index.html` from disk. |
| `GOOGLE_OAUTH_CLIENT_ID` | Google OAuth Desktop client ID (required for live Google sync). |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google OAuth Desktop client secret. |
| `MICROSOFT_CLIENT_ID` | Microsoft Entra public-client app ID (required for Microsoft Graph sync). |
| `MICROSOFT_CLIENT_SECRET` | Microsoft client secret (optional; public-client + loopback works without one). |

These are read from `process.env` in `src/main/ipc/auth-sync-ipc.ts`. In `npm run dev`,
electron-vite loads a project-root `.env` into the main process automatically. For a
**packaged build**, `src/main/load-credentials.ts` reads a plain `KEY=VALUE` file at
startup and copies any not-already-set variables into `process.env`. It checks, in order:

1. `<userData>/xrncal.env` — on Linux, `~/.config/xrncal/xrncal.env`
2. `xrncal.env` next to the executable / AppImage
3. `.env` in the current working directory

Example `~/.config/xrncal/xrncal.env`:

```
GOOGLE_OAUTH_CLIENT_ID=1234567890-abcdef.apps.googleusercontent.com
GOOGLE_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxx
```

Restart the app after editing. If credentials are missing, the "Connect Google/Microsoft"
buttons return a message pointing at this file instead of launching a broken OAuth flow.

> **Note:** `.env` is in `.gitignore`. Never commit OAuth credentials. Without these vars
> the app still runs in local + CalDAV mode; only Google/Microsoft sync is disabled.

See `.env.example` for the full list of environment variables.

---

## Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a project (or use an existing one).
3. Enable the **Google Calendar API**.
4. Create OAuth credentials: **Desktop app** type.
5. Download the client ID and client secret.
6. Set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in your environment.
7. Add test users in the OAuth consent screen (while in testing mode).

The app uses a loopback redirect URI (`http://127.0.0.1:<random-port>/oauth/callback`) — no redirect URI pre-registration is needed for Desktop app type.

---

## Microsoft Graph OAuth Setup

1. Go to [Azure Portal → Entra](https://portal.azure.com/).
2. Register a new application.
3. Set redirect URI to `http://localhost` (Desktop app).
4. Add API permissions: `Calendars.ReadWrite`, `offline_access`.
5. Set `MICROSOFT_CLIENT_ID` in your environment.

`src/main/oauth/microsoft-oauth.ts` implements the auth-code + PKCE loopback flow
directly against `login.microsoftonline.com` (Node `http` + `crypto`, system browser
via `shell.openExternal`) — no `@azure/msal-node` dependency.

---

## Data Storage Locations

| Platform | Path |
|----------|------|
| Windows | `%APPDATA%\xrncal\xrncal.sqlite` |
| Linux | `~/.config/xrncal/xrncal.sqlite` |

Determined by `app.getPath('userData')` in Electron.

OAuth tokens are stored encrypted via `safeStorage` in the same `userData` directory.

---

## Single-Instance Lock

The app enforces a single-instance lock via `app.requestSingleInstanceLock()`. If a second instance is launched, it focuses the existing window and quits immediately.

---

## System Tray

On both Windows and Linux, the app creates a system tray icon on startup. The tray menu provides:
- Show Main Window
- Open Mini Window
- Quit

On Linux, tray support depends on the desktop environment (GNOME, KDE). Tray initialization failure is non-fatal — the app logs a warning and continues.

---

## Linux Notes

- **Notifications:** Uses Electron's `Notification` API (backed by `libnotify` / DBus). Works on GNOME and KDE.
- **Tray:** Works on KDE out of the box. On GNOME, requires the AppIndicator extension (`gnome-shell-extension-appindicator`) or equivalent.
- **safeStorage:** Backed by `libsecret` (Secret Service API). On headless environments without a keyring, the app will refuse to persist OAuth tokens and display a visible error. It will not silently fall back to plaintext storage.
- **AppImage:** The packaged AppImage is self-contained. Run with `--no-sandbox` if needed in restricted environments (not recommended for production use).
