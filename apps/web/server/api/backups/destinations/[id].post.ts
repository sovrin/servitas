import { backupDestinationActionSchema } from '@servitas/contracts/backups'
import { queueDestinationOperation } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const input = backupDestinationActionSchema.safeParse(await readBody(event))
  if (!input.success)
    throw createError({ statusCode: 400, statusMessage: 'Choose a backup destination action.' })
  try {
    const job = queueDestinationOperation(
      platformDatabase(),
      getRouterParam(event, 'id')!,
      input.data.action === 'check' ? 'backup.check' : 'platform.backup',
    )
    setResponseStatus(event, 202)
    return job
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not queue this operation.',
    })
  }
})
