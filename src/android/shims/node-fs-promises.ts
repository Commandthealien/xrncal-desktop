import { readFileSync, writeFileSync, unlinkSync } from './node-fs'

/** Promise face of the same bridge calls; `ipc.ts` reads picked images here. */

export async function readFile(path: string, encoding?: string): Promise<any> {
  return readFileSync(path, encoding)
}

export async function writeFile(path: string, data: string | Uint8Array): Promise<void> {
  writeFileSync(path, data)
}

export async function unlink(path: string): Promise<void> {
  unlinkSync(path)
}

export default { readFile, writeFile, unlink }
