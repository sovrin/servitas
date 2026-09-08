import { backupDestinationSchema } from '@servitas/contracts/backups'
import { createBackupDestination } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
import { platformKey } from '../../../utils/apps'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = backupDestinationSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      statusMessage: 'Check backup destination settings.',
      data: { message: parsed.error.issues.map((issue) => issue.message).join(' ') },
    })
  try {
    const result = createBackupDestination(platformDatabase(), parsed.data, platformKey())
    setResponseStatus(event, 202)
    return result
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not save the destination.',
    })
  }
})
