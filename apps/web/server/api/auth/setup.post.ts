import { setupSchema } from '@servitas/contracts'
import { createOwner, getOwner, hashPassword, tokensMatch } from '@servitas/core'
import { checkAuthRate, setOwnerSession } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler(async (event) => {
  const db = platformDatabase()
  if (getOwner(db))
    throw createError({ statusCode: 409, statusMessage: 'The owner account already exists.' })
  checkAuthRate(event, 'setup')
  const body = setupSchema.safeParse(await readBody(event))
  if (!body.success)
    throw createError({
      statusCode: 400,
      statusMessage:
        'Enter a valid email, a password of 12–256 characters, and the installation key.',
    })
  const expected = process.env.SERVITAS_BOOTSTRAP_TOKEN
  if (!expected || expected.length < 32)
    throw createError({
      statusCode: 503,
      statusMessage: 'An installation key must be configured before setup.',
    })
  if (!tokensMatch(body.data.token, expected))
    throw createError({ statusCode: 401, statusMessage: 'The installation key is incorrect.' })
  const passwordHash = await hashPassword(body.data.password)
  if (!createOwner(db, body.data.email, passwordHash))
    throw createError({ statusCode: 409, statusMessage: 'The owner account already exists.' })
  setOwnerSession(event)
  setResponseStatus(event, 201)
  return { email: body.data.email }
})
