/**
 * Ambient declarations that let the *desktop* main-process sources typecheck
 * against the Android shim.
 *
 * `src/main/ipc.ts` annotates its dialog options with `Electron.*`, which the
 * real `electron` package supplies as a global namespace rather than as
 * exports. The shim replaces the module, not the namespace, so it is declared
 * here - narrowed to the members xrncal actually uses.
 */
declare namespace Electron {
  interface FileFilter {
    name: string
    extensions: string[]
  }

  interface OpenDialogOptions {
    title?: string
    defaultPath?: string
    buttonLabel?: string
    filters?: FileFilter[]
    properties?: string[]
    message?: string
  }

  interface SaveDialogOptions {
    title?: string
    defaultPath?: string
    buttonLabel?: string
    filters?: FileFilter[]
    message?: string
  }
}

declare namespace NodeJS {
  interface Process {
    /** Set by src/android/boot/polyfills.ts; read by src/preload/index.ts. */
    contextIsolated?: boolean
  }
}
