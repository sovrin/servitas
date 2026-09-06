import { resolve } from 'node:path'
import { openDatabase, resetOwner } from '../packages/core/src/index'

if (!process.argv.includes('--confirm'))
  throw new Error(
    'This removes the owner login and all sessions. Stop the web server, then pass --confirm to continue. App data and jobs are retained.',
  )
const db = openDatabase(resolve(process.env.SERVITAS_DATA_DIR || '.data'))
resetOwner(db)
db.close()
console.info(
  'Owner login and sessions removed. Configure a new installation key before restarting the web server and completing setup.',
)
