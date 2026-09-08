<script setup lang="ts">
import { ArrowLeft, RefreshCw } from '@lucide/vue'
import { errorMessage, formatTime } from '~/lib/format'
import { jobLabels } from '@servitas/contracts'
const route = useRoute()
const { data, error, refresh } = await useFetch(() => `/api/jobs/${route.params.id}`)
usePolling(refresh)
useHead({ title: () => `${data.value ? jobLabels[data.value.job.kind] : 'Operation'} · Servitas` })
const submitting = ref(false)
const retryError = ref('')
async function retry() {
  submitting.value = true
  retryError.value = ''
  try {
    const job = await $fetch('/api/jobs', { method: 'POST', body: { kind: 'platform.check' } })
    await navigateTo(`/operations/${job.id}`)
  } catch (cause) {
    retryError.value = errorMessage(cause)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div>
    <NuxtLink
      :to="data?.job.appId ? `/apps/${data.job.appId}` : '/platform'"
      class="mb-7 inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
      ><ArrowLeft :size="14" aria-hidden="true" />{{
        data?.job.appId ? 'Back to app' : 'Back to platform'
      }}</NuxtLink
    >
    <p v-if="retryError" role="alert" class="mb-4 text-sm text-destructive">{{ retryError }}</p>
    <div v-if="error" role="alert">
      <p class="text-sm text-destructive">{{ errorMessage(error) }}</p>
      <UiButton variant="outline" class="mt-3" @click="refresh()">Try again</UiButton>
    </div>
    <template v-else-if="data">
      <div class="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <div class="mb-3 flex items-center gap-3">
            <h1 class="text-2xl font-semibold tracking-tight">{{ jobLabels[data.job.kind] }}</h1>
            <JobStatus :status="data.job.status" />
          </div>
          <p class="text-sm text-muted-foreground">
            {{
              data.job.appId
                ? 'Saved progress for this app operation.'
                : ['backup.check', 'platform.backup'].includes(data.job.kind)
                  ? 'Saved backup progress and recovery details.'
                  : data.job.kind === 'repository.inspect'
                    ? 'Saved repository configuration and progress.'
                    : 'Storage, worker connection, and container runtime.'
            }}
          </p>
        </div>
        <UiButton
          v-if="
            data.job.kind === 'platform.check' && ['succeeded', 'failed'].includes(data.job.status)
          "
          variant="outline"
          :disabled="submitting"
          @click="retry"
          ><RefreshCw :size="15" aria-hidden="true" />{{
            submitting ? 'Queuing…' : 'Run again'
          }}</UiButton
        >
      </div>
      <p
        role="status"
        aria-live="polite"
        class="mb-6 rounded-md border px-4 py-3 text-sm"
        :class="
          data.job.status === 'failed' ? 'border-red-200 bg-red-50 text-destructive' : 'bg-muted'
        "
      >
        {{ data.job.message }}
      </p>
      <NuxtLink
        v-if="data.configurationReviewPath"
        :to="data.configurationReviewPath"
        class="mb-6 inline-block text-sm underline"
        >Review repository configuration</NuxtLink
      >
      <NuxtLink
        v-if="
          ['backup.check', 'platform.backup', 'app.backup', 'app.restore'].includes(data.job.kind)
        "
        :to="data.job.appId ? `/backups?app=${data.job.appId}` : '/backups'"
        class="mb-6 inline-block text-sm underline"
        >Back to backups</NuxtLink
      >
      <dl class="mb-8 grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt class="mb-1 text-xs text-muted-foreground">Created</dt>
          <dd class="tabular-nums">{{ formatTime(data.job.createdAt) }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-xs text-muted-foreground">Finished</dt>
          <dd class="tabular-nums">{{ formatTime(data.job.finishedAt) }}</dd>
        </div>
        <div>
          <dt class="mb-1 text-xs text-muted-foreground">Attempts</dt>
          <dd>{{ data.job.attempts }}</dd>
        </div>
      </dl>
      <section class="rounded-lg border bg-white" aria-labelledby="activity-heading">
        <h2 id="activity-heading" class="border-b px-5 py-4 text-sm font-medium">Activity</h2>
        <ol class="divide-y px-5">
          <li
            v-for="event in data.events"
            :key="event.id"
            class="flex flex-col gap-2 py-4 text-sm sm:flex-row sm:gap-6"
          >
            <time
              class="shrink-0 text-xs tabular-nums text-muted-foreground"
              :datetime="new Date(event.createdAt).toISOString()"
              >{{ formatTime(event.createdAt) }}</time
            ><span>{{ event.message }}</span>
          </li>
        </ol>
      </section>
      <p
        v-if="['queued', 'running'].includes(data.job.status)"
        class="mt-4 text-xs text-muted-foreground"
      >
        You can leave this page. The operation and its activity are saved.
      </p>
    </template>
  </div>
</template>
