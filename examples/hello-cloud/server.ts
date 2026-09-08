import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = process.env.DATA_DIR || '/data'
mkdirSync(dataDir, { recursive: true })
const counterPath = join(dataDir, 'visits.txt')
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'text/plain; charset=utf-8')
  if (request.url === '/health') return response.end('OK')
  let visits = 0
  try {
    visits = Number(readFileSync(counterPath, 'utf8')) || 0
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  writeFileSync(counterPath, String(++visits))
  response.end(`${process.env.MESSAGE || 'Hello from Servitas'}\nVisits saved on disk: ${visits}\n`)
}).listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.info('Hello Cloud is ready.'))

// Finish active writes before the platform snapshots persistent data.
process.once('SIGTERM', () => server.close(() => process.exit(0)))
