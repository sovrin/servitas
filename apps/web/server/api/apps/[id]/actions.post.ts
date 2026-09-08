import { appActionSchema } from '@servitas/contracts'
import { enqueueAppAction } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
import { requireApp } from '../../../utils/apps'

export default defineEventHandler(async (event) => {
  requireOwner(event)
  const app = requireApp(getRouterParam(event, 'id')!)
  const body = await readBody(event)
  const action = appActionSchema.safeParse(body?.action)
  if (!action.success)
    throw createError({ statusCode: 400, statusMessage: 'Choose a supported app action.' })
  if (action.data === 'remove' && body.confirmName !== app.name)
    throw createError({
      statusCode: 400,
      statusMessage: 'Confirm the app name to remove it. Persistent data will be retained.',
    })
  try {
    const job = enqueueAppAction(platformDatabase(), app.id, action.data)
    setResponseStatus(event, 202)
    return job
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not queue the app operation.',
    })
  }
})
