import { nativeBridge, unwrap } from '../native/bridge'
import { toBase64, fromBase64 } from './buffer-polyfill'

/**
 * Synchronous `node:fs` over the Android bridge.
 *
 * Only the calls xrncal's main-process code makes are implemented. Anything
 * else throws by name rather than being left undefined, so an unported code
 * path fails at the call site instead of somewhere downstream.
 */

export function existsSync(path: string): boolean {
  try {
    return nativeBridge().fsExists(path)
  } catch {
    return false
  }
}

export function mkdirSync(path: string, _options?: { recursive?: boolean }): void {
  unwrap<null>('fsMkdirs', nativeBridge().fsMkdirs(path))
}

export function writeFileSync(
  path: string,
  data: string | Uint8Array,
  _encoding?: string | { encoding?: string }
): void {
  const base64 = typeof data === 'string' ? toBase64(new TextEncoder().encode(data)) : toBase64(data)
  unwrap<null>('fsWriteBase64', nativeBridge().fsWriteBase64(path, base64))
}

export function readFileSync(path: string, encoding?: string | { encoding?: string }): any {
  const base64 = unwrap<string>('fsReadBase64', nativeBridge().fsReadBase64(path))
  const bytes = fromBase64(base64)
  const enc = typeof encoding === 'string' ? encoding : encoding?.encoding
  if (enc && enc !== 'buffer') return new TextDecoder().decode(bytes)
  return bytes
}

export function unlinkSync(path: string): void {
  unwrap<null>('fsUnlink', nativeBridge().fsUnlink(path))
}

export function statSync(path: string): { size: number } {
  const size = unwrap<number>('fsSize', nativeBridge().fsSize(path))
  return { size }
}

export default { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync, statSync }
