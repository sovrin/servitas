import { backupScheduleSchema } from '@servitas/contracts/backups'
import { saveBackupSchedule } from '@servitas/core'
import { requireOwner } from '../../../utils/auth'
import { platformDatabase } from '../../../utils/platform'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = backupScheduleSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      statusMessage: 'Check the backup settings and required confirmation.',
    })
  try {
    saveBackupSchedule(platformDatabase(), getRouterParam(event, 'id')!, parsed.data)
    setResponseStatus(event, 200)
    return { saved: true }
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not save this operation.',
    })
  }
})
