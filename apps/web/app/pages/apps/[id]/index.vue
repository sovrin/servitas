<script setup lang="ts">
import { ArrowLeft, ArrowUpRight, Play, Square, RefreshCw, Trash2 } from '@lucide/vue'
import { appTemplates } from '@servitas/contracts/templates'
import { jobLabels, type AppRevision } from '@servitas/contracts'
import { errorMessage, formatTime } from '~/lib/format'
const route = useRoute()
const { data, error, refresh } = await useFetch(() => `/api/apps/${route.params.id}`)
usePolling(refresh)
useHead({ title: () => `${data.value?.app.name || 'App'} · Servitas` })
const template = computed(() => {
  const source = data.value?.app.manifest.source
  if (source?.type !== 'image') return
  return appTemplates.find(
    (item) =>
      item.manifest.source.type === 'image' &&
      source.image.startsWith(item.manifest.source.image.split(':')[0] + ':'),
  )
})
const pending = ref(false)
const actionError = ref('')
const removeOpen = ref(false)
const recoverOpen = ref(false)
const confirmCompatibility = ref(false)
const recoveryTarget = ref<AppRevision | null>(null)
const recoveryGeneration = ref(0)
const recoverable = computed(() =>
  data.value?.revisions.find((r) => r.phase === 'applied' || r.requiresRecovery),
)
const recoveryNeedsConfirmation = computed(
  () =>
    !!(
      data.value?.app.manifest.volumes.length ||
      recoveryTarget.value?.previous.manifest.volumes.length
    ),
)
watch(recoverOpen, (open) => {
  if (open) {
    recoveryTarget.value = recoverable.value ? JSON.parse(JSON.stringify(recoverable.value)) : null
    recoveryGeneration.value = data.value?.app.generation || 0
    confirmCompatibility.value = false
  }
})
const section = ref<'activity' | 'logs' | 'settings'>('activity')
const activeJob = computed(() =>
  data.value?.jobs.find((job) => ['queued', 'running'].includes(job.status)),
)
watch(
  () => data.value?.app.status,
  (status) => {
    if (status === 'removed') navigateTo('/')
  },
)
async function action(value: 'deploy' | 'start' | 'stop' | 'remove' | 'restart') {
  pending.value = true
  actionError.value = ''
  try {
    await $fetch(`/api/apps/${route.params.id}/actions`, {
      method: 'POST',
      body: { action: value, ...(value === 'remove' ? { confirmName: data.value!.app.name } : {}) },
    })
    await refresh()
  } catch (cause) {
    actionError.value = errorMessage(cause)
  } finally {
    pending.value = false
  }
}
async function retryUpdate() {
  pending.value = true
  actionError.value = ''
  try {
    await $fetch(`/api/apps/${route.params.id}/retry-update`, { method: 'POST', body: {} })
    await refresh()
  } catch (cause) {
    actionError.value = errorMessage(cause)
  } finally {
    pending.value = false
  }
}
async function recover() {
  pending.value = true
  actionError.value = ''
  try {
    await $fetch(`/api/apps/${route.params.id}/rollback`, {
      method: 'POST',
      body: {
        confirmDataCompatibility: confirmCompatibility.value,
        revisionId: recoveryTarget.value!.id,
        expectedGeneration: recoveryGeneration.value,
      },
    })
    await refresh()
  } catch (cause) {
    actionError.value = errorMessage(cause)
  } finally {
    pending.value = false
  }
}
</script>
<template>
  <div>
    <NuxtLink to="/" class="mb-7 inline-flex items-center gap-2 text-xs text-muted-foreground"
      ><ArrowLeft :size="14" aria-hidden="true" />Back to apps</NuxtLink
    >
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ errorMessage(error) }}
      <UiButton variant="outline" size="sm" @click="refresh()">Try again</UiButton>
    </p>
    <template v-else-if="data">
      <div class="mb-8 flex flex-wrap items-end justify-between gap-5">
        <div>
          <div class="mb-3 flex flex-wrap items-center gap-3">
            <h1 class="text-3xl font-semibold tracking-tight">{{ data.app.name }}</h1>
            <AppStatus :status="data.app.status" />
          </div>
          <p class="break-all text-sm text-muted-foreground">
            {{ data.app.url }} <span class="ml-2 capitalize">· {{ data.app.manifest.access }}</span>
          </p>
        </div>
        <UiButton
          v-if="data.app.status === 'running' && data.app.desiredState === 'running'"
          as-child
          ><a :href="`/open/${data.app.id}`" target="_blank" rel="noopener noreferrer"
            >Open app<ArrowUpRight :size="15" aria-hidden="true" /></a
        ></UiButton>
      </div>
      <p
        v-if="actionError"
        role="alert"
        class="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-destructive"
      >
        {{ actionError }}
      </p>
      <div
        role="status"
        class="mb-6 rounded-md border px-4 py-3 text-sm"
        :class="
          data.app.status === 'failed' ? 'border-red-200 bg-red-50 text-destructive' : 'bg-muted'
        "
      >
        {{ activeJob?.message || data.app.message }}
        <p v-if="activeJob" class="mt-1 text-xs text-muted-foreground">
          You can leave this page. Progress is saved.
        </p>
      </div>
      <details v-if="template" class="mb-6 rounded-md border p-4 text-sm">
        <summary class="cursor-pointer font-medium">App setup and storage</summary>
        <p class="mt-3 text-muted-foreground">{{ template.notes }}</p>
        <a
          :href="template.documentation"
          target="_blank"
          rel="noopener noreferrer"
          class="mt-2 inline-block text-xs underline"
          >App documentation</a
        >
      </details>
      <div class="mb-8 flex flex-wrap items-center gap-2">
        <UiButton variant="outline" size="sm" as-child
          ><NuxtLink :to="`/backups?app=${data.app.id}`">Backups</NuxtLink></UiButton
        >
        <UiButton
          v-if="data.revisions[0]?.phase === 'failed'"
          variant="outline"
          size="sm"
          :disabled="pending || !!activeJob"
          @click="retryUpdate"
          >Retry update</UiButton
        >
        <UiButton v-if="!activeJob" variant="outline" size="sm" as-child
          ><NuxtLink :to="`/apps/${data.app.id}/edit`">Update app</NuxtLink></UiButton
        >
        <UiButton
          v-if="data.app.status === 'running'"
          variant="outline"
          size="sm"
          :disabled="pending || !!activeJob"
          @click="action('restart')"
          >Restart app</UiButton
        >
        <UiAlertDialog v-if="recoverable?.previous.imageId" v-model:open="recoverOpen">
          <UiAlertDialogTrigger as-child
            ><UiButton variant="outline" size="sm" :disabled="pending || !!activeJob"
              >Recover previous version</UiButton
            ></UiAlertDialogTrigger
          >
          <UiAlertDialogContent>
            <UiAlertDialogHeader
              ><UiAlertDialogTitle>Recover previous version?</UiAlertDialogTitle>
              <UiAlertDialogDescription
                >The saved image, configuration, and environment values will be deployed again. This
                does not undo changes to stored data.</UiAlertDialogDescription
              >
            </UiAlertDialogHeader>
            <p class="break-all text-xs">
              {{
                recoveryTarget?.previous.manifest.source.type === 'image'
                  ? recoveryTarget?.previous.manifest.source.image
                  : recoveryTarget?.previous.commit
              }}
              · {{ recoveryTarget?.previous.manifest.access }}
            </p>
            <label v-if="recoveryNeedsConfirmation" class="flex items-start gap-2 text-sm"
              ><input v-model="confirmCompatibility" type="checkbox" class="mt-1 accent-primary" />I
              have checked that the previous version can use the current app data.</label
            >
            <UiAlertDialogFooter
              ><UiAlertDialogCancel>Cancel</UiAlertDialogCancel
              ><UiAlertDialogAction
                :disabled="recoveryNeedsConfirmation && !confirmCompatibility"
                @click="recover"
                >Recover version</UiAlertDialogAction
              ></UiAlertDialogFooter
            >
          </UiAlertDialogContent>
        </UiAlertDialog>
        <UiButton
          v-if="data.app.status === 'running'"
          variant="outline"
          size="sm"
          :disabled="pending || !!activeJob"
          @click="action('stop')"
          ><Square :size="14" aria-hidden="true" />Stop app</UiButton
        >
        <UiButton
          v-if="data.app.status === 'stopped'"
          variant="outline"
          size="sm"
          :disabled="pending || !!activeJob"
          @click="action('start')"
          ><Play :size="14" aria-hidden="true" />Start app</UiButton
        >
        <UiButton
          v-if="
            ['failed', 'unknown', 'pending'].includes(data.app.status) &&
            !recoverable?.requiresRecovery
          "
          variant="outline"
          size="sm"
          :disabled="pending || !!activeJob"
          @click="action('deploy')"
          ><RefreshCw :size="14" aria-hidden="true" />Retry deployment</UiButton
        >
        <UiAlertDialog v-model:open="removeOpen"
          ><UiAlertDialogTrigger as-child
            ><UiButton
              variant="ghost"
              size="sm"
              :disabled="pending || !!activeJob"
              class="text-muted-foreground"
              ><Trash2 :size="14" aria-hidden="true" />Remove app</UiButton
            ></UiAlertDialogTrigger
          ><UiAlertDialogContent
            ><UiAlertDialogHeader
              ><UiAlertDialogTitle>Remove {{ data.app.name }}?</UiAlertDialogTitle
              ><UiAlertDialogDescription
                >The app container and its route will be removed. Named storage volumes and their
                data will be retained.</UiAlertDialogDescription
              ></UiAlertDialogHeader
            ><UiAlertDialogFooter
              ><UiAlertDialogCancel>Keep app</UiAlertDialogCancel
              ><UiAlertDialogAction @click="action('remove')"
                >Remove app</UiAlertDialogAction
              ></UiAlertDialogFooter
            ></UiAlertDialogContent
          ></UiAlertDialog
        >
      </div>
      <nav aria-label="App details" class="mb-6 flex gap-5 border-b">
        <button
          v-for="item in ['activity', 'logs', 'settings'] as const"
          :key="item"
          type="button"
          class="border-b-2 px-1 pb-3 text-sm capitalize"
          :class="
            section === item
              ? 'border-primary font-medium'
              : 'border-transparent text-muted-foreground'
          "
          :aria-current="section === item ? 'page' : undefined"
          @click="section = item"
        >
          {{ item === 'logs' ? 'Runtime logs' : item }}
        </button>
      </nav>
      <section v-if="section === 'activity'" aria-label="Deployment activity">
        <ol class="divide-y rounded-lg border bg-white">
          <li
            v-for="event in data.events"
            :key="event.id"
            class="flex flex-col gap-2 px-5 py-4 text-sm sm:flex-row sm:gap-5"
          >
            <time
              class="shrink-0 text-xs tabular-nums text-muted-foreground"
              :datetime="new Date(event.createdAt).toISOString()"
              >{{ formatTime(event.createdAt) }}</time
            ><span class="min-w-0 whitespace-pre-wrap break-words">{{ event.message }}</span>
          </li>
        </ol>
        <template v-if="data.revisions[0]?.phase === 'failed' && data.revisions[0].logs">
          <h2 class="mb-3 mt-8 text-sm font-medium">Failed replacement logs</h2>
          <pre class="max-h-72 overflow-auto rounded-md border bg-muted p-4 text-xs" tabindex="0">{{
            data.revisions[0].logs
          }}</pre>
        </template>
        <h2 class="mb-3 mt-8 text-sm font-medium">Operation history</h2>
        <ul class="divide-y border-y">
          <li v-for="job in data.jobs" :key="job.id">
            <NuxtLink
              :to="`/operations/${job.id}`"
              class="flex items-center justify-between gap-3 py-3 text-sm"
              ><span>{{ jobLabels[job.kind] }}</span
              ><JobStatus :status="job.status"
            /></NuxtLink>
          </li>
        </ul>
      </section>
      <section v-else-if="section === 'logs'" aria-label="Runtime logs">
        <div class="mb-3 flex justify-between text-xs text-muted-foreground">
          <span>Recent output · secret values redacted</span
          ><span>{{ formatTime(data.app.logsAt) }}</span>
        </div>
        <pre
          class="max-h-[32rem] overflow-auto rounded-lg border bg-[#202320] p-4 text-xs leading-relaxed text-[#e5e7e1]"
          tabindex="0"
          >{{ data.app.logs || 'No runtime output recorded yet.' }}</pre>
      </section>
      <section v-else aria-label="App settings">
        <dl class="divide-y text-sm">
          <div class="grid gap-2 py-4 sm:grid-cols-[160px_1fr]">
            <dt class="text-muted-foreground">Source</dt>
            <dd class="break-all">
              {{
                data.app.manifest.source.type === 'image'
                  ? data.app.manifest.source.image
                  : data.app.manifest.source.url
              }}
            </dd>
          </div>
          <div v-if="data.app.commit" class="grid gap-2 py-4 sm:grid-cols-[160px_1fr]">
            <dt class="text-muted-foreground">Deployed commit</dt>
            <dd class="break-all font-mono text-xs">{{ data.app.commit }}</dd>
          </div>
          <div class="grid gap-2 py-4 sm:grid-cols-[160px_1fr]">
            <dt class="text-muted-foreground">HTTP port / health</dt>
            <dd>{{ data.app.manifest.port }} · {{ data.app.manifest.healthCheck }}</dd>
          </div>
          <div class="grid gap-2 py-4 sm:grid-cols-[160px_1fr]">
            <dt class="text-muted-foreground">Resource limits</dt>
            <dd>
              {{ data.app.manifest.resources.memoryMb }} MB ·
              {{ data.app.manifest.resources.cpu }} CPU cores
            </dd>
          </div>
          <div class="grid gap-2 py-4 sm:grid-cols-[160px_1fr]">
            <dt class="text-muted-foreground">Environment</dt>
            <dd>
              {{ data.app.environmentNames.join(', ') || 'No variables configured' }}
              <p class="mt-1 text-xs text-muted-foreground">Stored values are not displayed.</p>
            </dd>
          </div>
          <div class="grid gap-2 py-4 sm:grid-cols-[160px_1fr]">
            <dt class="text-muted-foreground">Storage</dt>
            <dd>
              <p v-for="volume in data.app.manifest.volumes" :key="volume.name">
                {{ volume.name }} → {{ volume.mountPath }}
              </p>
              <p v-if="!data.app.manifest.volumes.length">No named volumes configured</p>
            </dd>
          </div>
        </dl>
        <p class="mt-5 text-xs text-muted-foreground">
          Use Update app to edit these settings or deploy another version.
        </p>
      </section>
    </template>
  </div>
</template>
