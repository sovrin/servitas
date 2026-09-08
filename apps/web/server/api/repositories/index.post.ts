import { repositoryInspectionSchema } from '@servitas/contracts/configuration'
import { queueRepositoryInspection } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = repositoryInspectionSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      statusMessage: 'Check the repository URL, revision, and configuration path.',
    })
  try {
    const inspection = queueRepositoryInspection(platformDatabase(), parsed.data)
    setResponseStatus(event, 202)
    return inspection
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not read this repository.',
    })
  }
})
