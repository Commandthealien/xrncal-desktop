import { fetchWithTimeout } from '@main/sync/http'
import type { ISqliteDatabase } from '../platform/sqlite-driver'
import { SecureStore } from '../platform/secure-store'
import { generatePkce, randomUrlSafe, awaitAuthorizationCode } from './pkce'

/**
 * Android replacement for `src/main/oauth/microsoft-oauth.ts`.
 *
 * Identical surface and token handling; the loopback listener becomes a custom
 * scheme, and `clientSecret` is ignored. Entra's "Mobile and desktop
 * applications" platform is a public client - it issues no secret, and sending
 * one makes the token request fail rather than succeed.
 */

export interface MicrosoftTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  tokenType: string
  scope: string
}

export interface MicrosoftUserInfo {
  id: string
  userPrincipalName?: string
  displayName?: string
  mail?: string
}

const MS_AUTH_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const MS_TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const GRAPH_ME_ENDPOINT = 'https://graph.microsoft.com/v1.0/me'
const MS_SCOPES = 'Calendars.ReadWrite offline_access User.Read'

/**
 * Entra accepts an arbitrary custom scheme for a mobile client as long as the
 * app registration lists the identical string. This must stay in step with the
 * intent filter in AndroidManifest.xml.
 */
export const MICROSOFT_REDIRECT_URI = 'app.xrncal.android://oauth2callback'

export class MicrosoftOAuthManager {
  private secureStore: SecureStore

  constructor(private db: ISqliteDatabase) {
    this.secureStore = new SecureStore(db)
  }

  async startAuthFlow(
    clientId: string,
    _clientSecret?: string
  ): Promise<{ account: { id: string; name: string; email: string }; tokens: MicrosoftTokens }> {
    if (!this.secureStore.isAvailable()) {
      throw new Error(
        'Android Keystore is unavailable. Set a device screen lock, then connect the account again.'
      )
    }

    const { verifier, challenge } = await generatePkce()
    const state = randomUrlSafe(16)

    const authUrl = new URL(MS_AUTH_ENDPOINT)
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('redirect_uri', MICROSOFT_REDIRECT_URI)
    authUrl.searchParams.set('response_mode', 'query')
    authUrl.searchParams.set('scope', MS_SCOPES)
    authUrl.searchParams.set('code_challenge', challenge)
    authUrl.searchParams.set('code_challenge_method', 'S256')
    authUrl.searchParams.set('state', state)
    authUrl.searchParams.set('prompt', 'select_account')

    const { code } = await awaitAuthorizationCode(authUrl.toString(), state, 'Microsoft')

    const tokenParams = new URLSearchParams({
      client_id: clientId,
      code,
      code_verifier: verifier,
      grant_type: 'authorization_code',
      redirect_uri: MICROSOFT_REDIRECT_URI,
      scope: MS_SCOPES
    })

    const tokenRes = await fetchWithTimeout(MS_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenParams.toString()
    })

    if (!tokenRes.ok) {
      throw new Error(`Token exchange failed: ${await tokenRes.text()}`)
    }

    const tokenData = await tokenRes.json()
    const tokens: MicrosoftTokens = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
      tokenType: tokenData.token_type || 'Bearer',
      scope: tokenData.scope || ''
    }

    const userRes = await fetchWithTimeout(GRAPH_ME_ENDPOINT, {
      headers: { Authorization: `Bearer ${tokens.accessToken}` }
    })
    const userInfo: MicrosoftUserInfo = userRes.ok
      ? await userRes.json()
      : { id: `ms_${Date.now()}`, displayName: 'Microsoft Account', mail: 'user@outlook.com' }

    const email = userInfo.mail || userInfo.userPrincipalName || 'user@outlook.com'
    const name = userInfo.displayName || 'Microsoft User'

    const accountId = `acc_graph_${userInfo.id}`
    const now = new Date().toISOString()

    this.db
      .prepare(
        `INSERT INTO accounts (id, type, name, email, is_active, created_at, updated_at)
         VALUES (?, 'graph', ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, email = excluded.email, is_active = 1, updated_at = excluded.updated_at`
      )
      .run(accountId, name, email, now, now)

    this.secureStore.storeToken(accountId, tokens)

    return { account: { id: accountId, name, email }, tokens }
  }

  async getValidAccessToken(
    accountId: string,
    clientId: string,
    _clientSecret?: string
  ): Promise<string> {
    const tokens = this.secureStore.getToken<MicrosoftTokens>(accountId)
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
      grant_type: 'refresh_token',
      scope: MS_SCOPES
    })

    const res = await fetchWithTimeout(MS_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshParams.toString()
    })

    if (!res.ok) {
      throw new Error(`Failed to refresh Microsoft token: ${await res.text()}`)
    }

    const data = await res.json()
    const updatedTokens: MicrosoftTokens = {
      ...tokens,
      accessToken: data.access_token,
      // Entra rotates the refresh token on every use; keeping the old one
      // means the next refresh fails with invalid_grant and the account
      // silently drops off sync.
      refreshToken: data.refresh_token || tokens.refreshToken,
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
