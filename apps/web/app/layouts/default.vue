<script setup lang="ts">
import { Boxes, Activity, LogOut, ArrowUpRight } from '@lucide/vue'
import type { AuthStatus } from '@servitas/contracts'
import { errorMessage } from '~/lib/format'
const auth = useState<AuthStatus | null>('auth')
const signingOut = ref(false)
const error = ref('')
async function logout() {
  signingOut.value = true
  error.value = ''
  try {
    await $fetch('/api/auth/logout', { method: 'POST', body: {} })
    clearNuxtData()
    await navigateTo('/login')
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    signingOut.value = false
  }
}
</script>

<template>
  <div class="min-h-screen md:grid md:grid-cols-[220px_1fr]">
    <a
      href="#main"
      class="sr-only z-50 focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:rounded focus:bg-background focus:p-3"
      >Skip to content</a
    >
    <aside
      class="border-b bg-[#f4f5f1] md:sticky md:top-0 md:flex md:h-screen md:flex-col md:border-r md:border-b-0"
    >
      <div class="flex items-center justify-between p-5 md:px-6 md:py-8">
        <NuxtLink to="/" aria-label="Servitas home"><BrandMark /></NuxtLink
        ><UiBadge variant="outline" class="text-[10px] font-normal md:hidden">Foundation</UiBadge>
      </div>
      <nav aria-label="Main navigation" class="flex gap-1 px-3 pb-3 md:flex-col">
        <NuxtLink
          to="/"
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
          exact-active-class="!bg-white !text-foreground shadow-xs"
          ><Boxes :size="17" aria-hidden="true" />Apps</NuxtLink
        >
        <NuxtLink
          to="/platform"
          class="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-secondary hover:text-foreground"
          active-class="!bg-white !text-foreground shadow-xs"
          ><Activity :size="17" aria-hidden="true" />Platform</NuxtLink
        >
      </nav>
      <div class="hidden px-6 py-6 md:mt-auto md:block">
        <div class="mb-2 text-xs font-medium text-muted-foreground">PERSONAL CLOUD</div>
        <p class="text-xs leading-relaxed text-muted-foreground">
          Your apps and data,<br />on a server you control.
        </p>
      </div>
    </aside>
    <div class="min-w-0">
      <header class="flex min-h-16 items-center justify-between gap-4 border-b px-5 md:px-10">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span class="size-1.5 rounded-full bg-primary" aria-hidden="true" /><span
            >Personal workspace</span
          ><UiBadge variant="outline" class="ml-2 hidden text-[10px] font-normal sm:inline-flex"
            >Foundation</UiBadge
          >
        </div>
        <div class="flex min-w-0 items-center gap-3">
          <span class="hidden max-w-52 truncate text-xs text-muted-foreground sm:block">{{
            auth?.owner?.email
          }}</span
          ><UiButton variant="ghost" size="sm" :disabled="signingOut" @click="logout"
            ><LogOut :size="14" aria-hidden="true" /><span>Sign out</span></UiButton
          >
        </div>
      </header>
      <p v-if="error" role="alert" class="px-5 py-3 text-sm text-destructive">{{ error }}</p>
      <main id="main" class="mx-auto max-w-6xl px-5 py-8 md:px-10 md:py-12"><slot /></main>
      <footer
        class="mx-auto mt-8 flex max-w-6xl items-center justify-between px-5 py-6 text-xs text-muted-foreground md:px-10"
      >
        <span>Servitas · Your personal cloud</span
        ><NuxtLink to="/platform" class="inline-flex items-center gap-1 hover:text-foreground"
          >Platform status <ArrowUpRight :size="12" aria-hidden="true"
        /></NuxtLink>
      </footer>
    </div>
  </div>
</template>
