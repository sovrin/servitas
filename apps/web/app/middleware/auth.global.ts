import type { AuthStatus } from '@servitas/contracts'

export default defineNuxtRouteMiddleware(async (to) => {
  const auth = useState<AuthStatus | null>('auth', () => null)
  auth.value = await useRequestFetch()<AuthStatus>('/api/auth/status')
  if (auth.value.setupRequired && to.path !== '/setup') return navigateTo('/setup')
  if (!auth.value.setupRequired && !auth.value.owner && to.path !== '/login')
    return navigateTo('/login')
  if (auth.value.owner && ['/setup', '/login'].includes(to.path)) {
    if (typeof to.query.next === 'string' && /^\/open\/[a-f0-9-]{36}$/.test(to.query.next))
      return navigateTo(to.query.next, { external: true })
    return navigateTo('/')
  }
})
