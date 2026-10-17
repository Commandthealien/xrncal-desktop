import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchWithTimeout,
  RequestTimeoutError,
  describeHttpFailure,
  readTextWithin,
  ResponseTooLargeError,
  describeError
} from '../src/main/sync/http'

/**
 * Node's fetch has no default request timeout, so a stalled provider connection
 * used to hang SyncWorker's `isSyncing` flag on permanently.
 */
describe('fetchWithTimeout', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('rejects with RequestTimeoutError when the response never arrives', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
      )
    )

    await expect(fetchWithTimeout('https://example.test/hang', {}, 20)).rejects.toBeInstanceOf(
      RequestTimeoutError
    )
  })

  it('passes a normal response straight through', async () => {
    const body = new Response('ok', { status: 200 })
    vi.stubGlobal('fetch', vi.fn(async () => body))

    const res = await fetchWithTimeout('https://example.test/ok')
    expect(res.status).toBe(200)
  })

  it('fails a body that stops arriving, which res.json() would wait on for good', async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":['))
        // ...and nothing more, ever.
      }
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stalled, { status: 200 })))

    const res = await fetchWithTimeout('https://example.test/stall', {}, 30)
    await expect(res.json()).rejects.toBeInstanceOf(RequestTimeoutError)
  })

  it('lets a slow body through as long as it keeps coming, and keeps the URL', async () => {
    const chunks = ['{"a":', '1', '}']
    const slow = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 20))
        const next = chunks.shift()
        if (next === undefined) controller.close()
        else controller.enqueue(new TextEncoder().encode(next))
      }
    })
    const upstream = new Response(slow, { status: 207 })
    Object.defineProperty(upstream, 'url', { value: 'https://example.test/final' })
    vi.stubGlobal('fetch', vi.fn(async () => upstream))

    // 50 ms idle allowance; the whole body takes ~80 ms.
    const res = await fetchWithTimeout('https://example.test/slow', {}, 50)
    expect(res.status).toBe(207)
    expect(res.url).toBe('https://example.test/final')
    await expect(res.json()).resolves.toEqual({ a: 1 })
  })

  it('passes a response with no body as it is', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const res = await fetchWithTimeout('https://example.test/empty')
    expect(res.status).toBe(204)
  })

  it('propagates a caller abort as an AbortError, not a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const err = new Error('aborted')
              err.name = 'AbortError'
              reject(err)
            })
          })
      )
    )

    const controller = new AbortController()
    const pending = fetchWithTimeout('https://example.test/slow', { signal: controller.signal }, 5000)
    controller.abort()

    await expect(pending).rejects.toSatisfy(
      (err: Error) => err.name === 'AbortError' && !(err instanceof RequestTimeoutError)
    )
  })

  // The deadline cannot depend on fetch noticing the abort: a transport that
  // ignores the signal must still be cut off.
  it('still times out when fetch ignores its abort signal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

    await expect(fetchWithTimeout('https://example.test/deaf', { method: 'PUT' }, 20)).rejects.toBeInstanceOf(
      RequestTimeoutError
    )
  })

  it('still honours a caller abort when fetch ignores its abort signal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))

    const controller = new AbortController()
    const pending = fetchWithTimeout('https://example.test/deaf', { signal: controller.signal }, 5000)
    controller.abort()

    await expect(pending).rejects.toSatisfy(
      (err: Error) => err.name === 'AbortError' && !(err instanceof RequestTimeoutError)
    )
  })

  it('aborts the underlying request when the deadline passes', async () => {
    let seen: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        seen = init.signal ?? undefined
        return new Promise(() => {})
      })
    )

    await expect(fetchWithTimeout('https://example.test/deaf', {}, 20)).rejects.toBeInstanceOf(
      RequestTimeoutError
    )
    expect(seen?.aborted).toBe(true)
  })
})

describe('describeHttpFailure', () => {
  it('includes the status and the provider body, which is where the reason is', async () => {
    const res = new Response('{"error":{"code":400,"message":"Invalid resource id value."}}', {
      status: 400,
      statusText: 'Bad Request'
    })

    const detail = await describeHttpFailure(res)

    expect(detail).toContain('400')
    expect(detail).toContain('Invalid resource id value.')
  })

  it('truncates a body long enough to be an HTML error page', async () => {
    const res = new Response('x'.repeat(5000), { status: 500, statusText: 'Server Error' })

    const detail = await describeHttpFailure(res)

    expect(detail.length).toBeLessThan(600)
    expect(detail).toContain('…')
  })

  it('still says something useful when the body cannot be read', async () => {
    const res = { status: 403, statusText: 'Forbidden', text: () => Promise.reject(new Error('gone')) }

    const detail = await describeHttpFailure(res as unknown as Response)

    expect(detail).toBe('HTTP 403 Forbidden')
  })
})

describe('readTextWithin', () => {
  const streamOf = (chunks: string[], stallAfter = false): Response => {
    const encoder = new TextEncoder()
    let i = 0
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]))
          else if (!stallAfter) controller.close()
          // Stalled: never enqueue or close again.
        }
      })
    )
  }

  it('reads a body that arrives in pieces', async () => {
    await expect(readTextWithin(streamOf(['BEGIN:', 'VCALENDAR']), 'u', 1000)).resolves.toBe('BEGIN:VCALENDAR')
  })

  it('stops at the size cap without reading the rest', async () => {
    await expect(readTextWithin(streamOf(['x'.repeat(600), 'x'.repeat(600)]), 'u', 1000)).rejects.toBeInstanceOf(
      ResponseTooLargeError
    )
  })

  it('gives up on a body that stops arriving after the headers', async () => {
    await expect(readTextWithin(streamOf(['BEGIN:'], true), 'u', 1000, 20)).rejects.toBeInstanceOf(
      RequestTimeoutError
    )
  })
})

describe('describeError', () => {
  it('adds the reason fetch keeps on its cause', () => {
    const err = new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND dav.example') })
    expect(describeError(err)).toBe('fetch failed: getaddrinfo ENOTFOUND dav.example')
  })

  it('leaves other errors as they are', () => {
    expect(describeError(new Error('CalDAV PUT failed: HTTP 403'))).toBe('CalDAV PUT failed: HTTP 403')
    expect(describeError('plain')).toBe('plain')
  })
})
