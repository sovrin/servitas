import { getRepositoryInspection } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler((event) => {
  requireOwner(event)
  const inspection = getRepositoryInspection(platformDatabase(), getRouterParam(event, 'id')!)
  if (!inspection)
    throw createError({ statusCode: 404, statusMessage: 'Repository operation not found.' })
  return inspection
})
