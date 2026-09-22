import { installBufferPolyfill } from '../shims/buffer-polyfill'

/**
 * Side-effect module, imported *first* by the Android entry point.
 *
 * `src/main/**` is written for Node and reaches for two bare globals that a
 * WebView does not have. ES modules evaluate in import order, so importing
 * this before any main-process module guarantees the globals exist by the
 * time those modules' bodies run.
 */

installBufferPolyfill()

const g = globalThis as any

if (!g.process) {
  g.process = {}
}
if (!g.process.env) {
  // `load-credentials.ts` copies OAuth client ids in here, and the OAuth
  // managers read them back out.
  g.process.env = {}
}
if (!g.process.platform) {
  // Surfaced to the renderer through IPC_CHANNELS.APP.GET_PLATFORM. App.tsx
  // branches on it for platform-specific chrome, so it has to be a value the
  // renderer recognises rather than Node's 'linux'.
  g.process.platform = 'android'
}
if (typeof g.process.cwd !== 'function') {
  g.process.cwd = () => '/'
}
if (!g.process.versions) {
  g.process.versions = { node: '0.0.0' }
}
// `contextIsolated` is read by src/preload/index.ts to decide between the
// context bridge and a direct window assignment. There is no isolated world
// here, so the direct path is the correct one.
if (typeof g.process.contextIsolated === 'undefined') {
  g.process.contextIsolated = false
}
