<script setup lang="ts">
import { Boxes, Plus, ArrowUpRight } from '@lucide/vue'
import { errorMessage } from '~/lib/format'
useHead({ title: 'Apps · Servitas' })
const { data, error, refresh } = await useFetch('/api/apps')
usePolling(refresh)
</script>
<template>
  <div>
    <div class="mb-9 flex flex-wrap items-end justify-between gap-5">
      <div>
        <p class="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Your workspace
        </p>
        <h1 class="text-3xl font-semibold tracking-tight">Apps</h1>
        <p class="mt-2 text-sm text-muted-foreground">Your tools, running on your server.</p>
      </div>
      <div v-if="data?.enabled" class="flex flex-wrap gap-2">
        <UiButton variant="outline" as-child
          ><NuxtLink to="/apps/templates">Browse templates</NuxtLink></UiButton
        >
        <UiButton as-child
          ><NuxtLink to="/apps/new"
            ><Plus :size="15" aria-hidden="true" />Install app</NuxtLink
          ></UiButton
        >
      </div>
    </div>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ errorMessage(error) }}
      <UiButton variant="outline" size="sm" @click="refresh()">Try again</UiButton>
    </p>
    <template v-else-if="data">
      <div class="flex items-center justify-between border-b pb-3 text-sm">
        <span class="font-medium"
          >Your apps <span class="ml-2 text-muted-foreground">{{ data.apps.length }}</span></span
        ><NuxtLink to="/platform" class="text-xs text-muted-foreground hover:text-foreground"
          >Check your platform</NuxtLink
        >
      </div>
      <ul v-if="data.apps.length" class="divide-y border-b">
        <li v-for="app in data.apps" :key="app.id">
          <NuxtLink
            :to="`/apps/${app.id}`"
            class="flex flex-wrap items-center justify-between gap-4 py-5 hover:bg-muted/50"
            ><div class="flex min-w-0 items-center gap-4">
              <div
                class="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-white"
              >
                <Boxes :size="18" class="text-muted-foreground" aria-hidden="true" />
              </div>
              <div class="min-w-0">
                <p class="text-sm font-medium">{{ app.name }}</p>
                <p class="mt-1 break-all text-xs text-muted-foreground">
                  {{
                    app.manifest.source.type === 'image'
                      ? app.manifest.source.image
                      : app.manifest.source.url
                  }}
                </p>
              </div>
            </div>
            <div class="flex items-center gap-4">
              <span class="text-xs capitalize text-muted-foreground">{{ app.manifest.access }}</span
              ><AppStatus :status="app.status" /><ArrowUpRight
                :size="15"
                class="text-muted-foreground"
                aria-hidden="true"
              /></div
          ></NuxtLink>
        </li>
      </ul>
      <section
        v-else
        class="flex min-h-80 flex-col items-center justify-center border-b px-5 py-14 text-center"
      >
        <div class="mb-5 flex size-12 items-center justify-center rounded-xl border bg-white">
          <Boxes :size="22" class="text-muted-foreground" aria-hidden="true" />
        </div>
        <h2 class="text-lg font-medium">A home for your first app.</h2>
        <p class="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {{
            data.enabled
              ? 'Install from a container image or a public Git repository. Manage its status, access, and logs here.'
              : 'App routing is not configured for this installation. Platform checks are still available.'
          }}
        </p>
        <UiButton v-if="data.enabled" as-child class="mt-6"
          ><NuxtLink to="/apps/new"
            ><Plus :size="15" aria-hidden="true" />Install your first app</NuxtLink
          ></UiButton
        >
      </section>
    </template>
  </div>
</template>
