import { updateAppSchema } from '@servitas/contracts'
import { queueUpdate } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
import { platformKey } from '../../../utils/apps'

export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = updateAppSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({ statusCode: 400, statusMessage: 'Check the update settings.' })
  try {
    const job = queueUpdate(
      platformDatabase(),
      getRouterParam(event, 'id')!,
      parsed.data,
      platformKey(),
    )
    setResponseStatus(event, 202)
    return job
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not queue the update.',
    })
  }
})
