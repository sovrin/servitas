import { backupRequestSchema } from '@servitas/contracts/backups'
import { queueAppBackup } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
import { platformKey } from '../../../utils/apps'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = backupRequestSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      statusMessage: 'Check the backup settings and required confirmation.',
    })
  try {
    const result = queueAppBackup(
      platformDatabase(),
      getRouterParam(event, 'id')!,
      parsed.data.destinationId,
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
