/**
 * Enough of `Buffer` for the three main-process call sites that use it:
 *
 *   caldav-adapter.ts   Buffer.from(`${user}:${pass}`).toString('base64')
 *   auth-sync-ipc.ts    Buffer.from(normalizedUrl).toString('hex').slice(0, 10)
 *   parse-ics.ts        Buffer.byteLength(icsContent, 'utf-8')
 *
 * The hex case matters for correctness, not just convenience: the CalDAV
 * account id is derived from it, so a polyfill that encoded differently from
 * Node would mint a *new* account id for a server the user had already paired,
 * orphaning its calendars. Encoding is therefore UTF-8 bytes -> hex, byte for
 * byte identical to Node.
 */

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  // Chunked to stay clear of the argument-count limit on large ICS payloads.
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

class BufferShim extends Uint8Array {
  toString(encoding: string = 'utf-8'): string {
    switch (encoding) {
      case 'base64':
        return toBase64(this)
      case 'hex':
        return toHex(this)
      case 'utf-8':
      case 'utf8':
      case 'ascii':
        return new TextDecoder().decode(this)
      default:
        throw new Error(`Buffer.toString: unsupported encoding "${encoding}"`)
    }
  }
}

export const Buffer = {
  from(input: string | Uint8Array | ArrayBuffer, encoding: string = 'utf-8'): BufferShim {
    if (typeof input === 'string') {
      if (encoding === 'base64') return new BufferShim(fromBase64(input))
      if (encoding === 'hex') {
        const bytes = new Uint8Array(input.length / 2)
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(input.substr(i * 2, 2), 16)
        }
        return new BufferShim(bytes)
      }
      return new BufferShim(new TextEncoder().encode(input))
    }
    return new BufferShim(input instanceof ArrayBuffer ? new Uint8Array(input) : input)
  },

  byteLength(input: string, _encoding: string = 'utf-8'): number {
    return new TextEncoder().encode(input).length
  },

  isBuffer(value: unknown): boolean {
    return value instanceof BufferShim
  }
}

/**
 * Installed on globalThis by the Android entry point before any main-process
 * module is imported, because those modules reference the bare global.
 */
export function installBufferPolyfill(): void {
  const g = globalThis as any
  if (!g.Buffer) g.Buffer = Buffer
}
