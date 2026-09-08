import { backupCredentialsSchema } from '@servitas/contracts/backups'
import { replaceBackupCredentials } from '@servitas/core'
import { requireOwner } from '../../../../utils/auth'
import { platformDatabase } from '../../../../utils/platform'
import { platformKey } from '../../../../utils/apps'
export default defineEventHandler(async (event) => {
  requireOwner(event)
  const input = backupCredentialsSchema.safeParse(await readBody(event))
  if (!input.success)
    throw createError({
      statusCode: 400,
      statusMessage: 'Enter credentials and confirm the saved recovery password.',
    })
  try {
    const job = replaceBackupCredentials(
      platformDatabase(),
      getRouterParam(event, 'id')!,
      input.data,
      platformKey(),
    )
    setResponseStatus(event, 202)
    return job
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not update credentials.',
    })
  }
})
