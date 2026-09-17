import { XrncalAPI } from '@shared/ipc-contract'

declare global {
  interface Window {
    xrncal: XrncalAPI
  }
}
