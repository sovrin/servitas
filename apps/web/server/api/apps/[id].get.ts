import { listJobs, jobEvents, getApp, listRevisions } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'
import { appURL } from '../../utils/apps'

export default defineEventHandler((event) => {
  requireOwner(event)
  const app = getApp(platformDatabase(), getRouterParam(event, 'id')!)
  if (!app) throw createError({ statusCode: 404, statusMessage: 'App not found.' })
  const jobs = listJobs(platformDatabase(), app.id)
  return {
    app: { ...app, url: appURL(app) },
    jobs,
    revisions: listRevisions(platformDatabase(), app.id),
    events: jobs[0] ? jobEvents(platformDatabase(), jobs[0].id) : [],
  }
})
