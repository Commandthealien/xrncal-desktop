import { Browser } from '@capacitor/browser'
import { App, type URLOpenListenerEvent } from '@capacitor/app'

/**
 * Shared machinery for the two Android OAuth flows.
 *
 * Desktop xrncal runs a one-shot HTTP server on 127.0.0.1 and uses its URL as
 * the redirect target. Android has no usable loopback listener for this, and
 * both Google and Entra reject loopback redirects from a mobile client anyway.
 * The platform-native equivalent is a custom URI scheme: the authorization
 * server redirects to `<scheme>:/oauth2callback`, Android hands that URL to
 * whichever app declared the scheme, and Capacitor surfaces it as `appUrlOpen`.
 *
 * PKCE is not new here - the desktop managers already implement it. What
 * changes is that on Android it is the *only* protection, because a client
 * secret inside an APK is public. Both Android flows are therefore registered
 * as public clients and never send `client_secret`.
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function randomUrlSafe(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

export interface Pkce {
  verifier: string
  challenge: string
}

/**
 * WebCrypto's digest is async, unlike node:crypto's `createHash().digest()`,
 * so this returns a promise where the desktop helper is synchronous. The
 * calling flow is already async, so it costs nothing.
 */
export async function generatePkce(): Promise<Pkce> {
  const verifier = randomUrlSafe(32)
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) }
}

export class OAuthCancelledError extends Error {
  constructor(provider: string) {
    super(`${provider} sign-in was cancelled.`)
    this.name = 'OAuthCancelledError'
  }
}

export interface AuthCodeResult {
  code: string
  state: string | null
}

/**
 * Open the authorization page in a Chrome Custom Tab and resolve with the
 * authorization code the redirect carries back.
 *
 * A Custom Tab rather than an in-app WebView on purpose: it shares the
 * system browser's cookie jar (so an already signed-in user is not asked
 * again), it shows the real origin in a URL bar the app cannot forge, and
 * Google outright refuses OAuth from an embedded WebView.
 */
export function awaitAuthorizationCode(
  authUrl: string,
  expectedState: string,
  provider: string,
  timeoutMs = 5 * 60 * 1000
): Promise<AuthCodeResult> {
  return new Promise<AuthCodeResult>((resolve, reject) => {
    let settled = false
    let urlHandle: { remove: () => Promise<void> } | null = null
    let closeHandle: { remove: () => Promise<void> } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      timer = null
      void urlHandle?.remove()
      void closeHandle?.remove()
      urlHandle = null
      closeHandle = null
    }

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      cleanup()
      void Browser.close().catch(() => {
        // Already dismissed by the redirect; nothing to recover from.
      })
      fn()
    }

    timer = setTimeout(
      () => finish(() => reject(new Error(`${provider} sign-in timed out.`))),
      timeoutMs
    )

    void App.addListener('appUrlOpen', (event: URLOpenListenerEvent) => {
      let parsed: URL
      try {
        parsed = new URL(event.url)
      } catch {
        return
      }
      // Other deep links may reach the app; only the callback path is ours.
      if (!parsed.pathname.includes('oauth2callback') && !parsed.host.includes('oauth2callback')) {
        return
      }

      // Providers vary on whether params land in the query or the fragment.
      const params = parsed.searchParams.size
        ? parsed.searchParams
        : new URLSearchParams(parsed.hash.replace(/^#/, ''))

      const error = params.get('error')
      if (error) {
        const description = params.get('error_description')
        finish(() =>
          reject(new Error(`${provider} OAuth error: ${description ? `${error} - ${description}` : error}`))
        )
        return
      }

      const code = params.get('code')
      const state = params.get('state')

      // A mismatched state means the response is not the one this flow
      // started, so the code is not ours to redeem.
      if (state !== expectedState) {
        finish(() => reject(new Error('Invalid OAuth state; sign-in was not completed.')))
        return
      }
      if (!code) {
        finish(() => reject(new Error('Authorization response carried no code.')))
        return
      }

      finish(() => resolve({ code, state }))
    }).then((handle) => {
      if (settled) void handle.remove()
      else urlHandle = handle
    })

    // Dismissing the Custom Tab is a cancellation. Without this the promise
    // would hang until the timeout and the connect button would stay spinning
    // for five minutes.
    void Browser.addListener('browserFinished', () => {
      // The redirect also closes the browser, so defer: if the URL listener is
      // about to fire, it wins and `settled` is already true by the time this
      // runs.
      setTimeout(() => finish(() => reject(new OAuthCancelledError(provider))), 400)
    }).then((handle) => {
      if (settled) void handle.remove()
      else closeHandle = handle
    })

    void Browser.open({ url: authUrl, presentationStyle: 'popover' }).catch((err) => {
      finish(() => reject(err))
    })
  })
}
