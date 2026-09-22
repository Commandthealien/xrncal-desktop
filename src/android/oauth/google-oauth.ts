import { fetchWithTimeout } from '@main/sync/http'
import type { ISqliteDatabase } from '../platform/sqlite-driver'
import { SecureStore } from '../platform/secure-store'
import { generatePkce, randomUrlSafe, awaitAuthorizationCode } from './pkce'

/**
 * Android replacement for `src/main/oauth/google-oauth.ts`.
 *
 * Same public surface, same token shape, same storage. Two things differ, both
 * forced by the platform:
 *
 *  1. The loopback listener becomes a custom-scheme redirect (see ./pkce.ts).
 *  2. `clientSecret` is accepted for signature parity but deliberately ignored.
 *     Google issues Android OAuth clients as *public* clients with no secret,
 *     and a secret compiled into an APK is readable by anyone who unzips it -
 *     shipping one would be worse than useless, since it would also let Google
 *     treat the client as confidential.
 */

export interface GoogleTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenType: string
  scope: string
}

export interface GoogleUserInfo {
  id: string
  email: string
  name: string
  picture?: string
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar openid email profile'

/**
 * Google mandates the redirect scheme for an installed app: the client id with
 * its domain parts reversed. A client id of
 * `123-abc.apps.googleusercontent.com` must redirect to
 * `com.googleusercontent.apps.123-abc:/oauth2callback`, and anything else is
 * rejected with redirect_uri_mismatch. Deriving it here rather than hardcoding
 * keeps the scheme correct whenever the client id changes - but note the
 * AndroidManifest intent filter has to declare the same scheme, so changing
 * the client id means updating `googleRedirectScheme` in build.gradle too.
 */
export function googleRedirectUri(clientId: string): string {
  const suffix = '.apps.googleusercontent.com'
  if (!clientId.endsWith(suffix)) {
    throw new Error(
      `Google client id "${clientId}" is not an installed-app client id. ` +
        'Create an OAuth client of type "Android" in the Google Cloud console.'
    )
  }
  const prefix = clientId.slice(0, -suffix.length)
  return `com.googleusercontent.apps.${prefix}:/oauth2callback`
}

export class GoogleOAuthManager {
  private secureStore: SecureStore

  constructor(private db: ISqliteDatabase) {
    this.secureStore = new SecureStore(db)
  }

  async startAuthFlow(
    clientId: string,
    _clientSecret?: string
  ): Promise<{ account: { id: string; name: string; email: string }; tokens: GoogleTokens }> {
    if (!this.secureStore.isAvailable()) {
      throw new Error(
        'Android Keystore is unavailable. Set a device screen lock, then connect the account again.'
      )
    }

    const redirectUri = googleRedirectUri(clientId)
    const { verifier, challenge } = await generatePkce()
    const state = randomUrlSafe(16)

    const authUrl = new URL(GOOGLE_AUTH_ENDPOINT)
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', GOOGLE_SCOPES)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)
    // Without these a re-connect returns no refresh token, and the account
    // silently stops syncing an hour later.
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')

    const { code } = await awaitAuthorizationCode(authUrl.toString(), state, 'Google')

    const tokenParams = new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri
    })

    const tokenRes = await fetchWithTimeout(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    })

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${await tokenRes.text()}`)
    }

    const tokenData = await tokenRes.json()
    const tokens: GoogleTokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
      tokenType: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || ''
    }

    const userRes = await fetchWithTimeout(GOOGLE_USERINFO_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` }
    })
    const userInfo: GoogleUserInfo = userRes.ok
      ? await userRes.json()
      : { id: `g_${Date.now()}`, email: 'user@gmail.com', name: 'Google Account' }

    const accountId = `acc_google_${userInfo.id}`
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO accounts (id, type, name, email, is_active, created_at, updated_at)
         VALUES (?, 'google', ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, is_active = 1, updated_at = excluded.updated_at`
      )
      .run(accountId, userInfo.name, userInfo.email, now, now)

    this.secureStore.storeToken(accountId, tokens)

    return {
      account: { id: accountId, name: userInfo.name, email: userInfo.email },
      tokens
    }
  }

  async getValidAccessToken(
    accountId: string,
    clientId: string,
    _clientSecret?: string
  ): Promise<string> {
    const tokens = this.secureStore.getToken<GoogleTokens>(accountId)
    if (!tokens) {
      throw new Error(`No credentials found for account ${accountId}`)
    }

    if (tokens.expiresAt > Date.now() + 120 * 1000 && tokens.accessToken) {
      return tokens.accessToken
    }

    if (!tokens.refreshToken) {
      throw new Error(`Refresh token missing for account ${accountId}. Please re-authenticate.`)
    }

    const refreshParams = new URLSearchParams({
      client_id: clientId,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token'
    })

    const res = await fetchWithTimeout(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshParams.toString()
    })

    if (!res.ok) {
      throw new Error(`Failed to refresh Google token: ${await res.text()}`)
    }

    const data = await res.json()
    const updatedTokens: GoogleTokens = {
      ...tokens,
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in || 3600) * 1000
    }

    this.secureStore.storeToken(accountId, updatedTokens)
    return updatedTokens.accessToken
  }

  disconnectAccount(accountId: string): void {
    this.secureStore.deleteToken(accountId)
    const now = new Date().toISOString()
    this.db.prepare('UPDATE accounts SET is_active = 0, updated_at = ? WHERE id = ?').run(now, accountId)
  }
}
