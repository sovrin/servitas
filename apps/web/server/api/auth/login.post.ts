import { ownerCredentialsSchema } from '@servitas/contracts'
import { authenticate } from '@servitas/core'
import { checkAuthRate, setOwnerSession } from '../../utils/auth'
import { platformDatabase } from '../../utils/platform'

export default defineEventHandler(async (event) => {
  checkAuthRate(event, 'login')
  const body = ownerCredentialsSchema.safeParse(await readBody(event))
  if (
    !body.success ||
    !(await authenticate(platformDatabase(), body.data.email, body.data.password))
  ) {
    throw createError({ statusCode: 401, statusMessage: 'Email or password is incorrect.' })
  }
  setOwnerSession(event)
  return { email: body.data.email }
})
