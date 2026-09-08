import { platformOrigin } from '../utils/platform'

export default defineEventHandler((event) => {
  setHeader(event, 'X-Content-Type-Options', 'nosniff')
  setHeader(event, 'X-Frame-Options', 'DENY')
  setHeader(event, 'Referrer-Policy', 'same-origin')
  if (!event.path.startsWith('/api/')) return
  setHeader(event, 'Cache-Control', 'no-store')
  if (['GET', 'HEAD', 'OPTIONS'].includes(event.method)) return
  // Compare with a configured origin, never with caller-controlled forwarded headers.
  if (getHeader(event, 'origin') !== platformOrigin()) {
    throw createError({
      statusCode: 403,
      statusMessage: 'This request did not come from the platform.',
    })
  }
  if (
    event.method !== 'DELETE' &&
    !getHeader(event, 'content-type')?.startsWith('application/json')
  ) {
    throw createError({ statusCode: 415, statusMessage: 'Send application/json.' })
  }
})
