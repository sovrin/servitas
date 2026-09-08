import { queueRetryUpdate } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
import { platformKey } from '../../../utils/apps'

export default defineEventHandler((event) => {
  requireOwner(event)
  try {
    const job = queueRetryUpdate(platformDatabase(), getRouterParam(event, 'id')!, platformKey())
    setResponseStatus(event, 202)
    return job
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not retry the update.',
    })
  }
})
