import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { openDatabase, preparePlatformRecovery } from '@servitas/core'
const dataDir = process.env.SERVITAS_DATA_DIR
if (!dataDir || process.argv[2] !== '--confirm-offline-recovery')
  throw new Error(
    'Stop web and worker, then pass --confirm-offline-recovery with SERVITAS_DATA_DIR set.',
  )
if (
  readFileSync(resolve(dataDir, 'encryption-key')).length !== 32 ||
  !statSync(resolve(dataDir, 'servitas.sqlite')).isFile()
)
  throw new Error('Restore the platform database and its original encryption key first.')
const db = openDatabase(resolve(dataDir))
try {
  preparePlatformRecovery(db)
  console.info(
    'Platform metadata prepared. Start the platform, sign in, check the backup destination, and restore each app from Backups.',
  )
} finally {
  db.close()
}
