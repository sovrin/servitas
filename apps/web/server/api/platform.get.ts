import { listJobs, workerStatus } from '@servitas/core'
import { requireOwner } from '../utils/auth'
import { platformDatabase } from '../utils/platform'

export default defineEventHandler((event) => {
  requireOwner(event)
  const db = platformDatabase()
  return { worker: workerStatus(db), jobs: listJobs(db) }
})
