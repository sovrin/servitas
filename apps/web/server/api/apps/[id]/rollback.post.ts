import { rollbackAppSchema } from '@servitas/contracts'
import { queuePreviousVersion } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
import { platformKey } from '../../../utils/apps'

export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = rollbackAppSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({ statusCode: 400, statusMessage: 'Check the recovery confirmation.' })
  try {
    const job = queuePreviousVersion(
      platformDatabase(),
      getRouterParam(event, 'id')!,
      platformKey(),
      parsed.data,
    )
    setResponseStatus(event, 202)
    return job
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not queue recovery.',
    })
  }
})
