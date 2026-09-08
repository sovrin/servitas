import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export function encryptionKey(dataDir: string): Buffer {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const path = resolve(dataDir, 'encryption-key')
  try {
    writeFileSync(path, randomBytes(32), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const key = readFileSync(path)
  if (key.length !== 32) throw new Error('The platform encryption key is invalid.')
  return key
}

export function sealEnvironment(environment: Record<string, string>, key: Buffer) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const data = Buffer.concat([cipher.update(JSON.stringify(environment)), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), data]).toString('base64')
}

export function openEnvironment(sealed: string, key: Buffer): Record<string, string> {
  const data = Buffer.from(sealed, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return JSON.parse(
    Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(),
  )
}

export function redact(text: string, environment: Record<string, string>) {
  let result = text
  for (const value of Object.values(environment)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    result = result.split(value).join('[redacted]')
  return result
}
