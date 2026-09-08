import { createAppSchema } from '@servitas/contracts'
import { createApp } from '@servitas/core'
import { requireOwner } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'
import { appURL, platformKey } from '../../utils/apps'

export default defineEventHandler(async (event) => {
  requireOwner(event)
  const parsed = createAppSchema.safeParse(await readBody(event))
  if (!parsed.success)
    throw createError({
      statusCode: 400,
      statusMessage: 'Check the app settings.',
      data: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    })
  appURL(parsed.data.manifest)
  try {
    const result = createApp(platformDatabase(), parsed.data, platformKey())
    setResponseStatus(event, 202)
    return { id: result.app.id, jobId: result.job.id }
  } catch (error) {
    throw createError({
      statusCode: 409,
      statusMessage: error instanceof Error ? error.message : 'Could not create this app.',
    })
  }
})
