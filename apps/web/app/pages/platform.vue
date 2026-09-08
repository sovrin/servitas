<script setup lang="ts">
import { ArrowUpRight, RefreshCw, Server, CircleCheck } from '@lucide/vue'
import { formatTime, errorMessage } from '~/lib/format'
import { jobLabels } from '@servitas/contracts'
useHead({ title: 'Platform · Servitas' })
const { data, error, refresh } = await useFetch('/api/platform')
usePolling(refresh)
const submitting = ref(false)
const submitError = ref('')
const activeJob = computed(() =>
  data.value?.jobs.find(
    (job) => job.kind === 'platform.check' && ['queued', 'running'].includes(job.status),
  ),
)
async function runCheck() {
  submitting.value = true
  submitError.value = ''
  try {
    const job = await $fetch('/api/jobs', { method: 'POST', body: { kind: 'platform.check' } })
    await navigateTo(`/operations/${job.id}`)
  } catch (cause) {
    submitError.value = errorMessage(cause)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div>
    <div class="mb-9 flex flex-wrap items-end justify-between gap-5">
      <div>
        <p class="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          Behind your apps
        </p>
        <h1 class="text-3xl font-semibold tracking-tight">Platform</h1>
        <p class="mt-2 text-sm text-muted-foreground">
          Connection health and recent background operations.
        </p>
      </div>
      <UiButton :disabled="submitting || !!activeJob || !!error" @click="runCheck"
        ><RefreshCw :size="15" aria-hidden="true" />{{
          submitting ? 'Queuing…' : activeJob ? 'Check in progress' : 'Run platform check'
        }}</UiButton
      >
    </div>
    <p
      v-if="submitError"
      role="alert"
      class="mb-5 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-destructive"
    >
      {{ submitError }}
    </p>
    <div v-if="error" role="alert" class="rounded-md border p-5">
      <p class="text-sm text-destructive">{{ errorMessage(error) }}</p>
      <UiButton variant="outline" size="sm" class="mt-3" @click="refresh()">Try again</UiButton>
    </div>
    <template v-else-if="data">
      <section aria-labelledby="connection-heading" class="rounded-lg border bg-white">
        <div class="flex items-center gap-3 border-b px-5 py-4">
          <Server :size="17" class="text-muted-foreground" aria-hidden="true" />
          <h2 id="connection-heading" class="text-sm font-medium">Platform connection</h2>
        </div>
        <dl class="divide-y px-5 text-sm">
          <div class="flex flex-wrap items-center justify-between gap-3 py-4">
            <dt class="text-muted-foreground">Worker</dt>
            <dd class="flex items-center gap-2">
              <span
                :class="data.worker.online ? 'bg-emerald-600' : 'bg-amber-600'"
                class="size-1.5 rounded-full"
                aria-hidden="true"
              />{{ data.worker.online ? 'Connected' : 'Not connected' }}
            </dd>
          </div>
          <div class="flex flex-wrap items-center justify-between gap-3 py-4">
            <dt class="text-muted-foreground">Last contact</dt>
            <dd class="text-xs tabular-nums">{{ formatTime(data.worker.lastSeenAt) }}</dd>
          </div>
        </dl>
        <p
          v-if="!data.worker.online"
          class="border-t bg-muted px-5 py-3 text-xs leading-relaxed text-muted-foreground"
        >
          The worker has not checked in recently. Queued operations will wait until it reconnects.
        </p>
      </section>
      <section aria-labelledby="operations-heading" class="mt-10">
        <div class="mb-4 flex items-center justify-between">
          <h2 id="operations-heading" class="text-sm font-medium">Recent operations</h2>
          <span class="text-xs text-muted-foreground">{{ data.jobs.length }} recorded</span>
        </div>
        <p
          v-if="!data.jobs.length"
          class="rounded-lg border border-dashed px-5 py-10 text-center text-sm text-muted-foreground"
        >
          No operations yet. Run a check to verify your platform.
        </p>
        <ul v-else class="divide-y rounded-lg border bg-white">
          <li v-for="job in data.jobs" :key="job.id">
            <NuxtLink
              :to="`/operations/${job.id}`"
              class="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-muted"
              ><div class="min-w-0">
                <div class="flex items-center gap-2 text-sm font-medium">
                  <CircleCheck :size="15" class="text-muted-foreground" aria-hidden="true" />{{
                    jobLabels[job.kind]
                  }}
                </div>
                <p class="mt-1 text-xs leading-relaxed text-muted-foreground">{{ job.message }}</p>
              </div>
              <div class="flex items-center gap-3">
                <span class="hidden text-xs tabular-nums text-muted-foreground lg:inline">{{
                  formatTime(job.createdAt)
                }}</span
                ><JobStatus :status="job.status" /><ArrowUpRight
                  :size="14"
                  class="text-muted-foreground"
                  aria-hidden="true"
                /></div
            ></NuxtLink>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
