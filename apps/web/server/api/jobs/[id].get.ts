import { getJob, jobEvents } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler((event) => {
  requireOwner(event)
  const id = getRouterParam(event, 'id')!
  const db = platformDatabase()
  const job = getJob(db, id)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Operation not found.' })
  return { job, events: jobEvents(db, id) }
})
