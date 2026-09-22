/**
 * The posix slice of `node:path` that xrncal's main-process code actually
 * calls. Android paths are always posix, so no platform branching is needed.
 */

export const sep = '/'
export const delimiter = ':'

function normaliseSegments(path: string, keepLeadingDotDot: boolean): string {
  const isAbsolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!isAbsolute && keepLeadingDotDot) out.push('..')
      continue
    }
    out.push(segment)
  }
  const joined = out.join('/')
  if (isAbsolute) return `/${joined}`
  return joined === '' ? '.' : joined
}

export function join(...parts: string[]): string {
  const meaningful = parts.filter((p) => p !== '' && p !== undefined && p !== null)
  if (meaningful.length === 0) return '.'
  return normaliseSegments(meaningful.join('/'), true)
}

export function resolve(...parts: string[]): string {
  let resolved = ''
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (!part) continue
    resolved = resolved ? `${part}/${resolved}` : part
    if (part.startsWith('/')) break
  }
  if (!resolved.startsWith('/')) resolved = `/${resolved}`
  return normaliseSegments(resolved, false)
}

export function dirname(path: string): string {
  if (!path.includes('/')) return '.'
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const idx = trimmed.lastIndexOf('/')
  if (idx < 0) return '.'
  if (idx === 0) return '/'
  return trimmed.slice(0, idx)
}

export function basename(path: string, ext?: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  if (ext && base.endsWith(ext) && base !== ext) return base.slice(0, -ext.length)
  return base
}

export function extname(path: string): string {
  const base = basename(path)
  // A leading dot is part of the name, not an extension (`.env` has none).
  const idx = base.lastIndexOf('.')
  return idx <= 0 ? '' : base.slice(idx)
}

export function isAbsolute(path: string): boolean {
  return path.startsWith('/')
}

export default { sep, delimiter, join, resolve, dirname, basename, extname, isAbsolute }
