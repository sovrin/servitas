import { getJob, jobEvents, getRepositoryInspection } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler((event) => {
  requireOwner(event)
  const id = getRouterParam(event, 'id')!
  const db = platformDatabase()
  const job = getJob(db, id)
  if (!job) throw createError({ statusCode: 404, statusMessage: 'Operation not found.' })
  const inspection = job.kind === 'repository.inspect' ? getRepositoryInspection(db, id) : null
  const configurationReviewPath = inspection
    ? `${inspection.request.appId ? `/apps/${inspection.request.appId}/edit` : '/apps/new'}?configurationJob=${id}`
    : null
  return { job, events: jobEvents(db, id), configurationReviewPath }
})
