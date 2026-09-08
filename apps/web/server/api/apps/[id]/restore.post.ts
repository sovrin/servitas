import { restoreRequestSchema } from '@servitas/contracts/backups'
import { queueAppRestore } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
import { platformKey } from '../../../utils/apps'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = restoreRequestSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      statusMessage: 'Check the backup settings and required confirmation.',
    })
  try {
    const result = queueAppRestore(
      platformDatabase(),
      getRouterParam(event, 'id')!,
      parsed.data,
      platformKey(),
    )
    setResponseStatus(event, 202)
    return result || { saved: true }
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not save this operation.',
    })
  }
})
