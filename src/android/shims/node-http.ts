/**
 * `node:http` exists on desktop only to run the OAuth loopback listener on
 * 127.0.0.1. Android replaces that flow entirely with a custom-scheme redirect
 * (see src/android/oauth/), and both OAuth managers are swapped out by
 * androidModuleSwap, so nothing should reach this module.
 *
 * It throws rather than exporting a no-op server: a silently dead listener
 * would leave a connect flow hanging forever with no diagnostic.
 */
function unsupported(name: string): never {
  throw new Error(
    `node:http.${name} is not available on Android. OAuth uses a custom-scheme ` +
      'redirect (src/android/oauth/), not a loopback server.'
  )
}

export function createServer(): never {
  return unsupported('createServer')
}

export default { createServer }
