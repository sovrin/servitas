<script setup lang="ts">
import { Archive, Plus, RefreshCw } from '@lucide/vue'
import { backupDestinationSchema, type AppBackup } from '@servitas/contracts/backups'
import { jobLabels } from '@servitas/contracts'
import { errorMessage, formatTime } from '~/lib/format'
useHead({ title: 'Backups · Servitas' })
const route = useRoute()
const { data, error, refresh } = await useFetch('/api/backups')
usePolling(refresh)
const pending = ref(false)
const actionError = ref('')
const notice = ref('')
const appId = ref(typeof route.query.app === 'string' ? route.query.app : '')
const destinationId = ref('')
const maintenance = ref(false)
const daily = ref(false)
const hourUTC = ref('3')
const selectedApp = computed(() => data.value?.apps.find((app) => app.id === appId.value))
const appBusy = computed(() =>
  data.value?.operations.some(
    (operation) =>
      operation.job.appId === appId.value && ['queued', 'running'].includes(operation.job.status),
  ),
)
const selectedBackups = computed(
  () => data.value?.backups.filter((backup) => !appId.value || backup.appId === appId.value) || [],
)
const destinationBusy = (id: string) =>
  data.value?.operations.some(
    (operation) =>
      operation.destinationId === id && ['queued', 'running'].includes(operation.job.status),
  )
watch(
  appId,
  () => {
    const schedule = data.value?.schedules.find((item) => item.appId === appId.value)
    daily.value = schedule?.enabled || false
    hourUTC.value = String(schedule?.hourUTC ?? 3)
    destinationId.value =
      schedule?.destinationId ||
      data.value?.destinations.find((destination) => destination.checkedAt)?.id ||
      ''
    maintenance.value = false
  },
  { immediate: true },
)
const newDestination = reactive({
  name: '',
  endpoint: '',
  bucket: '',
  prefix: 'servitas',
  region: 'us-east-1',
  accessKey: '',
  secretKey: '',
  password: '',
  confirmRecoveryPasswordSaved: false,
  allowInsecureHTTP: false,
})
const showPassword = ref(false)
const editingCredentials = ref('')
const credentials = reactive({
  accessKey: '',
  secretKey: '',
  password: '',
  confirmRecoveryPasswordSaved: false,
})
watch(editingCredentials, () => {
  credentials.accessKey = ''
  credentials.secretKey = ''
  credentials.password = ''
  credentials.confirmRecoveryPasswordSaved = false
})
async function submit(action: () => Promise<unknown>, message: string) {
  pending.value = true
  actionError.value = ''
  notice.value = ''
  try {
    await action()
    await refresh()
    notice.value = message
  } catch (cause) {
    actionError.value = errorMessage(cause)
  } finally {
    pending.value = false
  }
}
async function saveDestination() {
  const parsed = backupDestinationSchema.safeParse(newDestination)
  if (!parsed.success) {
    actionError.value = parsed.error.issues.map((issue) => issue.message).join(' ')
    return
  }
  await submit(async () => {
    const result = await $fetch('/api/backups/destinations', { method: 'POST', body: parsed.data })
    destinationId.value = result.id
    newDestination.accessKey = ''
    newDestination.secretKey = ''
    newDestination.password = ''
    newDestination.confirmRecoveryPasswordSaved = false
  }, 'Destination saved. The worker is checking it; follow the operation below.')
}
async function destinationAction(id: string, action: 'check' | 'backup-platform') {
  await submit(
    () => $fetch<unknown>(`/api/backups/destinations/${id}`, { method: 'POST', body: { action } }),
    'Operation queued. Progress is saved below.',
  )
}
async function saveCredentials() {
  await submit(async () => {
    await $fetch<unknown>(`/api/backups/destinations/${editingCredentials.value}/credentials`, {
      method: 'POST',
      body: credentials,
    })
    editingCredentials.value = ''
  }, 'Credentials saved. The worker is checking the repository.')
}
async function backUp() {
  await submit(
    () =>
      $fetch<unknown>(`/api/apps/${appId.value}/backups`, {
        method: 'POST',
        body: { destinationId: destinationId.value, confirmMaintenance: maintenance.value },
      }),
    'Backup queued. The app will pause while its data is saved.',
  )
}
async function saveSchedule() {
  await submit(
    () =>
      $fetch<unknown>(`/api/apps/${appId.value}/backup-schedule`, {
        method: 'POST',
        body: {
          destinationId: destinationId.value,
          enabled: daily.value,
          hourUTC: Number(hourUTC.value),
          confirmMaintenance: maintenance.value,
        },
      }),
    'Daily backup settings saved.',
  )
}
const restoreOpen = ref(false)
const restoreTarget = ref<AppBackup | null>(null)
const restoreGeneration = ref(0)
const confirmName = ref('')
const confirmOverwrite = ref(false)
function reviewRestore(backup: AppBackup) {
  restoreTarget.value = JSON.parse(JSON.stringify(backup))
  restoreGeneration.value = data.value?.apps.find((app) => app.id === backup.appId)?.generation || 0
  confirmName.value = ''
  confirmOverwrite.value = false
  restoreOpen.value = true
}
async function restore() {
  const target = restoreTarget.value!
  await submit(
    () =>
      $fetch<unknown>(`/api/apps/${target.appId}/restore`, {
        method: 'POST',
        body: {
          backupId: target.id,
          expectedGeneration: restoreGeneration.value,
          confirmName: confirmName.value,
          confirmOverwrite: confirmOverwrite.value,
        },
      }),
    'Restore queued. The current volumes are retained while the restored app is checked.',
  )
}
</script>
<template>
  <div class="space-y-8">
    <div>
      <h1 class="text-3xl font-semibold tracking-tight">Backups</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        Encrypted app data and platform recovery, stored outside this server.
      </p>
    </div>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ errorMessage(error) }} <UiButton variant="outline" @click="refresh()">Try again</UiButton>
    </p>
    <p
      v-if="actionError"
      role="alert"
      class="rounded-md border p-3 whitespace-pre-wrap text-sm text-destructive"
    >
      {{ actionError }}
    </p>
    <p v-if="notice" role="status" class="rounded-md border bg-muted p-3 text-sm">{{ notice }}</p>
    <template v-if="data">
      <section class="space-y-4" aria-labelledby="destinations-heading">
        <h2 id="destinations-heading" class="text-base font-medium">Storage destinations</h2>
        <p v-if="!data.destinations.length" class="text-sm text-muted-foreground">
          Add an S3-compatible bucket on another server or storage provider. Servitas creates an
          encrypted repository inside its prefix.
        </p>
        <div
          v-for="destination in data.destinations"
          :key="destination.id"
          class="rounded-lg border p-4"
        >
          <div class="flex flex-wrap items-start justify-between gap-4">
            <div class="min-w-0">
              <h3 class="text-sm font-medium">{{ destination.name }}</h3>
              <p class="mt-1 break-all text-xs text-muted-foreground">
                {{ destination.endpoint }} / {{ destination.bucket }} / {{ destination.prefix }}
              </p>
              <p class="mt-2 text-xs">{{ destination.message }}</p>
              <p v-if="destination.checkedAt" class="mt-1 text-xs text-muted-foreground">
                Checked {{ formatTime(destination.checkedAt) }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <UiButton
                variant="outline"
                size="sm"
                :disabled="pending || destinationBusy(destination.id)"
                @click="destinationAction(destination.id, 'check')"
                ><RefreshCw :size="14" />Check and load backups</UiButton
              ><UiButton
                variant="outline"
                size="sm"
                :disabled="pending || destinationBusy(destination.id) || !destination.checkedAt"
                @click="destinationAction(destination.id, 'backup-platform')"
                >Back up platform</UiButton
              ><UiButton
                variant="ghost"
                size="sm"
                :disabled="pending || destinationBusy(destination.id)"
                @click="editingCredentials = destination.id"
                >Update credentials</UiButton
              >
            </div>
          </div>
        </div>
        <form
          v-if="editingCredentials"
          class="max-w-xl space-y-4 rounded-lg border p-4"
          @submit.prevent="saveCredentials"
        >
          <h3 class="text-sm font-medium">Update stored credentials</h3>
          <p class="text-xs text-muted-foreground">
            Enter the existing repository’s recovery password. This changes the saved connection
            credentials; it does not re-encrypt the repository.
          </p>
          <div class="space-y-2">
            <UiLabel for="replacement-access">Replacement access key</UiLabel
            ><UiInput
              id="replacement-access"
              v-model="credentials.accessKey"
              autocomplete="off"
              required
            />
          </div>
          <div class="space-y-2">
            <UiLabel for="replacement-secret">Replacement secret key</UiLabel
            ><UiInput
              id="replacement-secret"
              v-model="credentials.secretKey"
              type="password"
              autocomplete="new-password"
              required
            />
          </div>
          <div class="space-y-2">
            <UiLabel for="replacement-password">Existing recovery password</UiLabel
            ><UiInput
              id="replacement-password"
              v-model="credentials.password"
              type="password"
              minlength="20"
              autocomplete="new-password"
              required
            />
          </div>
          <label class="flex items-start gap-2 text-sm"
            ><input
              v-model="credentials.confirmRecoveryPasswordSaved"
              type="checkbox"
              required
              class="mt-1 accent-primary"
            />I have the recovery password saved outside this server.</label
          >
          <div class="flex gap-2">
            <UiButton :disabled="pending">Save credentials</UiButton
            ><UiButton type="button" variant="ghost" @click="editingCredentials = ''"
              >Cancel</UiButton
            >
          </div>
        </form>
        <details class="rounded-lg border p-4">
          <summary class="cursor-pointer text-sm font-medium">Add storage destination</summary>
          <form class="mt-5 max-w-xl space-y-4" @submit.prevent="saveDestination">
            <fieldset :disabled="pending" class="space-y-4">
              <div class="space-y-2">
                <UiLabel for="destination-name">Destination name</UiLabel
                ><UiInput
                  id="destination-name"
                  v-model="newDestination.name"
                  placeholder="Offsite backups"
                  required
                />
              </div>
              <div class="space-y-2">
                <UiLabel for="endpoint">S3 endpoint</UiLabel
                ><UiInput
                  id="endpoint"
                  v-model="newDestination.endpoint"
                  type="url"
                  placeholder="https://s3.example.com"
                  required
                />
              </div>
              <div class="grid gap-4 sm:grid-cols-2">
                <div class="space-y-2">
                  <UiLabel for="bucket">Bucket</UiLabel
                  ><UiInput id="bucket" v-model="newDestination.bucket" required />
                </div>
                <div class="space-y-2">
                  <UiLabel for="region">Region</UiLabel
                  ><UiInput id="region" v-model="newDestination.region" required />
                </div>
              </div>
              <div class="space-y-2">
                <UiLabel for="prefix">Repository prefix</UiLabel
                ><UiInput id="prefix" v-model="newDestination.prefix" required />
                <p class="text-xs text-muted-foreground">
                  Use a dedicated prefix for this platform. The bucket must already exist.
                </p>
              </div>
              <div class="space-y-2">
                <UiLabel for="access-key">Access key</UiLabel
                ><UiInput
                  id="access-key"
                  v-model="newDestination.accessKey"
                  autocomplete="off"
                  required
                />
              </div>
              <div class="space-y-2">
                <UiLabel for="secret-key">Secret key</UiLabel
                ><UiInput
                  id="secret-key"
                  v-model="newDestination.secretKey"
                  type="password"
                  autocomplete="new-password"
                  required
                />
              </div>
              <div class="space-y-2">
                <UiLabel for="recovery-password">Recovery password</UiLabel
                ><UiInput
                  id="recovery-password"
                  v-model="newDestination.password"
                  :type="showPassword ? 'text' : 'password'"
                  minlength="20"
                  autocomplete="new-password"
                  required
                /><label class="flex items-center gap-2 text-xs"
                  ><input v-model="showPassword" type="checkbox" class="accent-primary" />Show
                  recovery password</label
                >
                <p class="text-xs text-muted-foreground">
                  Create a strong password of at least 20 characters, or enter the existing
                  repository password. Save it in your password manager: it is required if this
                  server is lost.
                </p>
              </div>
              <label class="flex items-start gap-2 text-sm"
                ><input
                  v-model="newDestination.confirmRecoveryPasswordSaved"
                  type="checkbox"
                  required
                  class="mt-1 accent-primary"
                />I saved the recovery password outside this server.</label
              >
              <label
                v-if="newDestination.endpoint.startsWith('http:')"
                class="flex items-start gap-2 text-sm"
                ><input
                  v-model="newDestination.allowInsecureHTTP"
                  type="checkbox"
                  required
                  class="mt-1 accent-primary"
                />Allow unencrypted HTTP to this endpoint. Storage credentials travel without
                TLS.</label
              >
              <UiButton type="submit"><Plus :size="14" />Save and check destination</UiButton>
            </fieldset>
          </form>
        </details>
      </section>
      <section class="space-y-4 border-t pt-7" aria-labelledby="app-backups-heading">
        <h2 id="app-backups-heading" class="text-base font-medium">App backups</h2>
        <div class="max-w-xl space-y-4">
          <div class="space-y-2">
            <UiLabel for="backup-app">App</UiLabel
            ><select
              id="backup-app"
              v-model="appId"
              class="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
            >
              <option value="">All apps</option>
              <option v-for="app in data.apps" :key="app.id" :value="app.id">
                {{ app.name }}{{ app.status === 'removed' ? ' (removed)' : '' }}
              </option>
            </select>
          </div>
          <template v-if="selectedApp && selectedApp.status !== 'removed'">
            <div class="space-y-2">
              <UiLabel for="backup-destination">Backup destination</UiLabel
              ><select
                id="backup-destination"
                v-model="destinationId"
                class="flex h-9 w-full rounded-md border bg-background px-3 text-sm"
              >
                <option value="">Select a checked destination</option>
                <option
                  v-for="destination in data.destinations.filter((item) => item.checkedAt)"
                  :key="destination.id"
                  :value="destination.id"
                >
                  {{ destination.name }}
                </option>
              </select>
            </div>
            <p class="text-sm text-muted-foreground">
              Backups pause the app until its settings and volumes are uploaded. The app must handle
              a graceful shutdown. All backups are retained.
            </p>
            <label class="flex items-start gap-2 text-sm"
              ><input v-model="maintenance" type="checkbox" class="mt-1 accent-primary" />Allow this
              app to pause for manual and scheduled backups.</label
            >
            <UiButton
              :disabled="
                pending ||
                appBusy ||
                !maintenance ||
                !destinationId ||
                !['running', 'stopped'].includes(selectedApp.status)
              "
              @click="backUp"
              ><Archive :size="14" />Back up app</UiButton
            >
            <details class="rounded-md border p-4">
              <summary class="cursor-pointer text-sm font-medium">Daily schedule</summary>
              <div class="mt-4 space-y-3">
                <label class="flex items-center gap-2 text-sm"
                  ><input v-model="daily" type="checkbox" class="accent-primary" />Enable daily
                  backups</label
                >
                <div class="space-y-2">
                  <UiLabel for="backup-hour">Hour (UTC, 0–23)</UiLabel
                  ><UiInput
                    id="backup-hour"
                    v-model="hourUTC"
                    type="number"
                    min="0"
                    max="23"
                    class="max-w-32"
                  />
                </div>
                <p
                  v-if="data.schedules.find((item) => item.appId === appId)?.enabled"
                  class="text-xs text-muted-foreground"
                >
                  Next due:
                  {{ formatTime(data.schedules.find((item) => item.appId === appId)!.nextRunAt) }}.
                  Busy apps run when available.
                </p>
                <UiButton
                  variant="outline"
                  size="sm"
                  :disabled="pending || !destinationId || !maintenance"
                  @click="saveSchedule"
                  >Save schedule</UiButton
                >
              </div>
            </details>
          </template>
        </div>
        <p
          v-if="!selectedBackups.length"
          class="rounded-lg border border-dashed p-6 text-sm text-muted-foreground"
        >
          No saved backups yet. A completed backup will appear here.
        </p>
        <ul v-else class="divide-y rounded-lg border">
          <li
            v-for="backup in selectedBackups"
            :key="backup.id"
            class="flex flex-wrap items-center justify-between gap-3 p-4"
          >
            <div class="min-w-0">
              <p class="text-sm font-medium">
                {{ backup.appName }}
                <span class="ml-2 font-normal text-muted-foreground">{{
                  formatTime(backup.createdAt)
                }}</span>
              </p>
              <p class="mt-1 break-all text-xs text-muted-foreground">
                {{ data.destinations.find((item) => item.id === backup.destinationId)?.name }} ·
                {{ backup.manifest.volumes.length }} volumes ·
                {{ backup.commit?.slice(0, 12) || 'Container image' }}
              </p>
            </div>
            <UiButton
              variant="outline"
              size="sm"
              :disabled="
                pending ||
                data.operations.some(
                  (operation) =>
                    operation.job.appId === backup.appId &&
                    ['queued', 'running'].includes(operation.job.status),
                )
              "
              @click="reviewRestore(backup)"
              >Restore backup</UiButton
            >
          </li>
        </ul>
      </section>
      <section class="space-y-4 border-t pt-7">
        <h2 class="text-base font-medium">Recent backup operations</h2>
        <p class="text-xs text-muted-foreground">
          Operations continue after navigation or disconnection. Platform checkpoints include
          accounts, encrypted settings, and the platform encryption key; app volumes are saved
          separately.
        </p>
        <ul class="divide-y">
          <li v-for="operation in data.operations" :key="operation.job.id">
            <NuxtLink
              :to="`/operations/${operation.job.id}`"
              class="flex flex-wrap items-center justify-between gap-3 py-4 text-sm"
              ><div class="min-w-0">
                <p>
                  {{ jobLabels[operation.job.kind]
                  }}{{ operation.previous ? ` · ${operation.previous.name}` : '' }}
                </p>
                <p class="mt-1 break-words text-xs text-muted-foreground">
                  {{ operation.job.message }}
                </p>
              </div>
              <JobStatus :status="operation.job.status"
            /></NuxtLink>
          </li>
        </ul>
      </section>
    </template>
    <UiAlertDialog v-model:open="restoreOpen"
      ><UiAlertDialogContent
        ><UiAlertDialogHeader
          ><UiAlertDialogTitle>Restore {{ restoreTarget?.appName }}?</UiAlertDialogTitle
          ><UiAlertDialogDescription
            >Replace the app’s active data, environment values, and settings with the backup from
            {{ restoreTarget ? formatTime(restoreTarget.createdAt) : '' }}. The app pauses while its
            restored version is checked. Current volumes are retained.</UiAlertDialogDescription
          ></UiAlertDialogHeader
        >
        <p class="text-sm">
          Restored access: <strong>{{ restoreTarget?.manifest.access }}</strong
          >. Storage:
          {{
            restoreTarget?.manifest.volumes.map((volume) => volume.name).join(', ') || 'No volumes'
          }}.
        </p>
        <div class="space-y-2">
          <UiLabel for="restore-name">Type the app name to confirm</UiLabel
          ><UiInput id="restore-name" v-model="confirmName" autocomplete="off" />
        </div>
        <label class="flex items-start gap-2 text-sm"
          ><input v-model="confirmOverwrite" type="checkbox" class="mt-1 accent-primary" />Replace
          current app data and settings with this backup.</label
        ><UiAlertDialogFooter
          ><UiAlertDialogCancel>Cancel</UiAlertDialogCancel
          ><UiAlertDialogAction
            :disabled="pending || !confirmOverwrite || confirmName !== restoreTarget?.appName"
            @click="restore"
            >Restore selected backup</UiAlertDialogAction
          ></UiAlertDialogFooter
        ></UiAlertDialogContent
      ></UiAlertDialog
    >
  </div>
</template>
