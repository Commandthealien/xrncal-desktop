/**
 * `node:crypto` is reached only by the desktop OAuth managers, which Android
 * swaps out for WebCrypto-based equivalents. Kept as a loud stub so a future
 * import surfaces immediately instead of silently producing weak values.
 */
function unsupported(name: string): never {
  throw new Error(
    `node:crypto.${name} is not available on Android. Use globalThis.crypto ` +
      '(WebCrypto) - see src/android/oauth/pkce.ts.'
  )
}

export function randomBytes(): never {
  return unsupported('randomBytes')
}

export function createHash(): never {
  return unsupported('createHash')
}

export const randomUUID = (): string => globalThis.crypto.randomUUID()

export default { randomBytes, createHash, randomUUID }
