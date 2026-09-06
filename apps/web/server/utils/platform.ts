import { resolve } from 'node:path'
import { openDatabase } from '@servitas/core'

let database: ReturnType<typeof openDatabase> | undefined

export function platformDatabase() {
  const dataDir = process.env.SERVITAS_DATA_DIR
  if (!dataDir) throw new Error('SERVITAS_DATA_DIR must be set for the web server.')
  return (database ??= openDatabase(resolve(dataDir)))
}

export function platformOrigin() {
  const configured = process.env.SERVITAS_ORIGIN
  if (!configured) throw new Error('SERVITAS_ORIGIN must be set for the web server.')
  return new URL(configured).origin
}
