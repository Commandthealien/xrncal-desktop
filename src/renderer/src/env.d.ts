/// <reference types="vite/client" />
import type { XrncalAPI } from '@shared/ipc-contract'

declare global {
  interface Window {
    xrncal?: XrncalAPI
  }
}
