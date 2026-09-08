import { enqueuePlatformCheck } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler(async (event) => {
  requireOwner(event)
  const body = await readBody(event)
  if (body?.kind !== 'platform.check' || Object.keys(body).some((key) => key !== 'kind')) {
    throw createError({ statusCode: 400, statusMessage: 'Choose a supported operation.' })
  }
  setResponseStatus(event, 202)
  return enqueuePlatformCheck(platformDatabase())
})
