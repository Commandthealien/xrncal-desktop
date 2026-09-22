#!/usr/bin/env node
/**
 * Derives the Android OAuth redirect scheme from the configured Google client
 * id and writes it into android/gradle.properties.
 *
 * Why this exists: Google requires an installed-app redirect to use the client
 * id with its domain parts reversed
 * (`com.googleusercontent.apps.<id>:/oauth2callback`). That string has to
 * appear in two places that cannot read each other - the TypeScript flow
 * derives it at runtime, and AndroidManifest.xml must declare an intent filter
 * for it at build time. Keeping them in step by hand is exactly the kind of
 * thing that fails silently with `redirect_uri_mismatch` weeks later.
 *
 * Reads GOOGLE_OAUTH_CLIENT_ID from the environment or the project .env; the
 * same file the desktop build uses. Safe to re-run.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const GRADLE_PROPERTIES = resolve(root, 'android/gradle.properties')
const GOOGLE_SUFFIX = '.apps.googleusercontent.com'

function readDotEnv() {
  const file = resolve(root, '.env')
  if (!existsSync(file)) return {}
  const out = {}
  for (const rawLine of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    let value = line.slice(eq + 1).trim()
    if (/^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1)
    out[line.slice(0, eq).trim()] = value
  }
  return out
}

function upsertProperty(text, key, value) {
  const line = `${key}=${value}`
  const pattern = new RegExp(`^${key}=.*$`, 'm')
  if (pattern.test(text)) return text.replace(pattern, line)
  return `${text.trimEnd()}\n\n# Written by scripts/configure-android-oauth.mjs\n${line}\n`
}

const env = { ...readDotEnv(), ...process.env }
const clientId = env.GOOGLE_OAUTH_CLIENT_ID

if (!clientId) {
  console.error(
    'GOOGLE_OAUTH_CLIENT_ID is not set (checked the environment and .env).\n' +
      'Google sign-in will be unavailable in the APK; everything else still works.\n' +
      'Create an OAuth client of type "Android" in the Google Cloud console, add it\n' +
      'to .env, and re-run: npm run android:configure-oauth'
  )
  process.exit(1)
}

if (!clientId.endsWith(GOOGLE_SUFFIX)) {
  console.error(
    `GOOGLE_OAUTH_CLIENT_ID does not look like a Google client id (expected it to end in ${GOOGLE_SUFFIX}).\n` +
      `Got: ${clientId}`
  )
  process.exit(1)
}

const scheme = `com.googleusercontent.apps.${clientId.slice(0, -GOOGLE_SUFFIX.length)}`

if (!existsSync(GRADLE_PROPERTIES)) {
  console.error(`No ${GRADLE_PROPERTIES}. Run "npx cap add android" first.`)
  process.exit(1)
}

const current = readFileSync(GRADLE_PROPERTIES, 'utf8')
const updated = upsertProperty(current, 'googleRedirectScheme', scheme)

if (updated === current) {
  console.log(`googleRedirectScheme already set to ${scheme}`)
} else {
  writeFileSync(GRADLE_PROPERTIES, updated)
  console.log(`Wrote googleRedirectScheme=${scheme} to android/gradle.properties`)
}

console.log(
  '\nRegister this redirect URI on the OAuth client:\n' +
    `  ${scheme}:/oauth2callback\n` +
    '\nMicrosoft (Entra) uses a fixed one; add it under "Mobile and desktop applications":\n' +
    '  app.xrncal.android://oauth2callback'
)
