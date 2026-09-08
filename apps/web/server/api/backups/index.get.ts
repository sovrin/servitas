import {
  listAppBackups,
  listBackupDestinations,
  listBackupSchedules,
  listApps,
  listJobs,
  getBackupOperation,
} from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'
import { platformKey } from '../../utils/apps'
export default defineEventHandler((event) => {
  requireOwner(event)
  const db = platformDatabase()
  return {
    destinations: listBackupDestinations(db),
    backups: listAppBackups(db, platformKey()),
    schedules: listBackupSchedules(db),
    apps: listApps(db, true),
    operations: listJobs(db)
      .map((job) => getBackupOperation(db, job.id))
      .filter((operation) => operation !== null),
  }
})
