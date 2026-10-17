/**
 * Network helpers shared by the sync engines, CalDAV adapter and OAuth managers.
 *
 * Node's global `fetch` has no default request timeout: a connection that opens
 * and then stalls (captive portal, flaky VPN, provider hiccup) never settles.
 * That is fatal here because SyncWorker guards re-entry with an `isSyncing`
 * flag - one hung request wedges the flag on and every later poll short-circuits
 * with "sync already in progress" until the app restarts. Every outbound request
 * therefore goes through this wrapper.
 */

/** Default per-request ceiling. Generous enough for a slow CalDAV REPORT. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

export class RequestTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms: ${url}`)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * `fetch` with a hard deadline. Any caller-supplied `signal` still works - the
 * two are combined, so an external abort and the timeout both cancel.
 *
 * The deadline does not rely on `fetch` honouring the abort. It races the
 * request and rejects on its own, so a transport that ignores the signal still
 * cannot hold SyncWorker.isSyncing past the deadline.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const external = init.signal
  let timer: ReturnType<typeof setTimeout> | undefined
  let onExternalAbort = (): void => {}

  const cancelled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new RequestTimeoutError(url, timeoutMs))
      controller.abort()
    }, timeoutMs)
    onExternalAbort = () => {
      reject(abortErrorFrom(external))
      controller.abort()
    }
  })

  if (external) {
    if (external.aborted) onExternalAbort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    const res = await Promise.race([fetch(url, { ...init, signal: controller.signal }), cancelled])
    return withIdleDeadline(res, url, timeoutMs, controller)
  } catch (err: any) {
    // An abort raised by our own timer is reported as a timeout; an abort that
    // came from the caller's signal is left as-is.
    if (err?.name === 'AbortError' && !external?.aborted) {
      throw new RequestTimeoutError(url, timeoutMs)
    }
    throw err
  } finally {
    clearTimeout(timer)
    if (external) external.removeEventListener('abort', onExternalAbort)
  }
}

/** Statuses whose response may not have a body; `new Response()` refuses one. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * The deadline above ends when the headers arrive, and every caller then reads
 * the body with `res.json()` or `res.text()` - which wait for as long as the
 * server takes. A server that sent headers and then stalled (a phone that lost
 * its connection mid-response) held SyncWorker.isSyncing on for good. The body
 * now fails once no data has arrived for `idleMs`; a slow body that keeps
 * coming is left alone, and readTextWithin() is still there for a total limit.
 */
function withIdleDeadline(res: Response, url: string, idleMs: number, controller: AbortController): Response {
  if (!(res instanceof Response) || !res.body || NULL_BODY_STATUSES.has(res.status)) return res
  const reader = res.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new RequestTimeoutError(url, idleMs)), idleMs)
      })
      try {
        const chunk = await Promise.race([reader.read(), idle])
        if (chunk.done) stream.close()
        else stream.enqueue(chunk.value)
      } catch (err) {
        controller.abort()
        reader.cancel().catch(() => {})
        stream.error(err)
      } finally {
        clearTimeout(timer)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    }
  })
  const wrapped = new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
  // A Response built here has no URL; the CalDAV adapter resolves hrefs against it.
  Object.defineProperty(wrapped, 'url', { value: res.url })
  return wrapped
}

/**
 * Whether a failed request is worth trying again on the next poll. 401 and 403
 * count: a token can expire mid-sync, and Google reports rate limits as 403.
 * Anything else in the 4xx range is the provider saying no for good.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500
}

export class ResponseTooLargeError extends Error {
  constructor(url: string, maxBytes: number) {
    super(`Response from ${url} is larger than ${maxBytes} bytes`)
    this.name = 'ResponseTooLargeError'
  }
}

/**
 * Read a response body as text, with a size cap and a deadline of its own.
 *
 * `fetchWithTimeout` stops its clock once the headers arrive, so a server that
 * sends headers and then trickles (or stalls) the body would hold the caller -
 * and SyncWorker.isSyncing - for as long as it liked; and `res.text()` reads
 * everything before any size check can run. This stops at whichever limit is
 * hit first. Meant for bodies from servers the app does not know, such as a
 * subscribed calendar's feed.
 */
export async function readTextWithin(
  res: Response,
  url: string,
  maxBytes: number,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new RequestTimeoutError(url, timeoutMs)), timeoutMs)
  })

  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline])
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new ResponseTooLargeError(url, maxBytes)
      chunks.push(value)
    }
  } catch (err) {
    reader.cancel().catch(() => {})
    throw err
  } finally {
    clearTimeout(timer)
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8').decode(bytes)
}

/**
 * An error as one line a person can be shown. Node's `fetch` rejects with a
 * bare "fetch failed" and keeps the reason - ENOTFOUND, ECONNREFUSED, a
 * certificate error - on `cause`, which is what says whether the server is
 * off, misnamed or untrusted.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err)
  const cause = (err as { cause?: unknown }).cause
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return detail && !err.message.includes(detail) ? `${err.message}: ${detail}` : err.message
}

/** What `fetch` itself rejects with when its signal fires: the signal's reason. */
function abortErrorFrom(signal: AbortSignal | null | undefined): unknown {
  if (signal?.reason !== undefined) return signal.reason
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/**
 * Turn a non-OK response into something worth logging.
 *
 * A push that failed used to increment an error counter and nothing else - no
 * status, no body - so a provider rejecting every insert looked exactly like a
 * provider accepting every insert. Reading the body here is safe: the caller has
 * already decided the response failed and will not read it again.
 */
export async function describeHttpFailure(res: Response): Promise<string> {
  let body = ''
  try {
    body = (await res.text()).trim()
  } catch {
    // A body that cannot be read is not worth failing over; the status still says something.
  }
  if (body.length > 500) body = `${body.slice(0, 500)}…`
  return body ? `HTTP ${res.status} ${res.statusText}: ${body}` : `HTTP ${res.status} ${res.statusText}`
}
