<script setup lang="ts">
import { ArrowLeft, ArrowRight, Plus, X } from '@lucide/vue'
import {
  parseAppConfiguration,
  type AppConfiguration,
  type RepositoryInspection,
} from '@servitas/contracts/configuration'
import { createAppSchema, type HostedApp } from '@servitas/contracts'
import { errorMessage } from '~/lib/format'
import type { AppTemplate } from '@servitas/contracts/templates'
const props = defineProps<{ app?: HostedApp; template?: AppTemplate }>()
const initial = props.app?.manifest || props.template?.manifest
const removeEnvironment = ref<string[]>([])
const confirmMaintenance = ref(false)
const reviewOpen = ref(false)
const approved = ref(false)
const requiredEnv = ref<string[]>(initial?.requiredEnv || [])
const importNotice = ref('')
const importError = ref('')
const importInputKey = ref(0)
const needsMaintenance = computed(
  () => !!(props.app?.manifest.volumes.length || volumes.value.length),
)
const name = ref(initial?.name || '')
const sourceType = ref<'image' | 'git'>(initial?.source.type || 'image')
const image = ref(initial?.source.type === 'image' ? initial.source.image : '')
const gitURL = ref(initial?.source.type === 'git' ? initial.source.url : '')
const revision = ref(initial?.source.type === 'git' ? initial.source.revision : 'main')
const dockerfile = ref(initial?.source.type === 'git' ? initial.source.dockerfile : 'Dockerfile')
const port = ref(String(initial?.port || 3000))
const access = ref<'private' | 'public'>(initial?.access || 'private')
const memoryMb = ref(String(initial?.resources.memoryMb || 256))
const cpu = ref(String(initial?.resources.cpu || 1))
const healthCheck = ref(initial?.healthCheck || '/')
const environment = ref('')
const volumes = ref<{ name: string; mountPath: string }[]>(
  initial?.volumes.map((v) => ({ ...v })) || [],
)
const pending = ref(false)
const error = ref('')
const issues = ref<{ path: string; message: string }[]>([])
const fieldError = (path: string) => issues.value.find((issue) => issue.path === path)?.message
function applyConfiguration(config: AppConfiguration) {
  if (props.app && config.name !== props.app.name)
    throw new Error('This configuration belongs to a different app name.')
  name.value = config.name
  if (config.source) {
    sourceType.value = config.source.type
    if (config.source.type === 'image') image.value = config.source.image
    else {
      gitURL.value = config.source.url
      revision.value = config.source.revision
      dockerfile.value = config.source.dockerfile
    }
  }
  port.value = String(config.port)
  healthCheck.value = config.healthCheck
  access.value = config.access
  memoryMb.value = String(config.resources.memoryMb)
  cpu.value = String(config.resources.cpu)
  volumes.value = config.volumes.map((volume) => ({ ...volume }))
  requiredEnv.value = config.requiredEnv
  confirmMaintenance.value = false
  issues.value = []
}
const route = useRoute()
const router = useRouter()
const configurationPath = ref('')
const inspection = ref<RepositoryInspection | null>(null)
const inspecting = ref(false)
const repositoryError = ref('')
const inspectionId = computed(() =>
  typeof route.query.configurationJob === 'string' ? route.query.configurationJob : '',
)
async function refreshInspection() {
  if (!inspectionId.value) return
  const id = inspectionId.value
  try {
    const result = await $fetch(`/api/repositories/${id}`)
    if (inspectionId.value !== id) return
    inspection.value = result
    repositoryError.value = ''
  } catch (cause) {
    if (inspectionId.value === id) repositoryError.value = errorMessage(cause)
  }
}
if (import.meta.client)
  watch(
    inspectionId,
    () => {
      inspection.value = null
      void refreshInspection()
    },
    { immediate: true },
  )
usePolling(async () => {
  if (!inspection.value || ['queued', 'running'].includes(inspection.value.job.status))
    await refreshInspection()
})
async function inspectRepository() {
  inspecting.value = true
  repositoryError.value = ''
  try {
    const result = await $fetch('/api/repositories', {
      method: 'POST',
      body: {
        source: {
          type: 'git',
          url: gitURL.value,
          revision: revision.value,
          dockerfile: dockerfile.value,
        },
        path: configurationPath.value || undefined,
        appId: props.app?.id,
      },
    })
    await router.replace({ query: { ...route.query, configurationJob: result.job.id } })
    inspection.value = result
  } catch (cause) {
    repositoryError.value = errorMessage(cause)
  } finally {
    inspecting.value = false
  }
}
function editRepositoryDetails() {
  const request = inspection.value?.request
  if (!request) return
  sourceType.value = 'git'
  gitURL.value = request.source.url
  revision.value = request.source.revision
  dockerfile.value = request.source.dockerfile
  configurationPath.value = request.path || ''
}
function applyRepositoryConfiguration() {
  const result = inspection.value?.result
  if (!result || inspection.value?.job.status !== 'succeeded') return
  importError.value = ''
  importNotice.value = ''
  try {
    applyConfiguration(result.configuration)
    importNotice.value = `Imported ${result.path} at ${result.commit.slice(0, 12)}. Selected this commit for deployment. Review the settings before deploying.`
  } catch (cause) {
    importError.value = cause instanceof Error ? cause.message : 'Could not apply configuration.'
  }
}
async function importConfiguration(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  error.value = ''
  importNotice.value = ''
  importError.value = ''
  try {
    if (file.size > 65_536) throw new Error('Configuration files must be 64 KB or smaller.')
    const config = parseAppConfiguration(await file.text(), file.name)
    applyConfiguration(config)
    importNotice.value = `Imported ${file.name}. Review the settings${config.source ? '' : ' and select the app source'} before deploying.`
  } catch (cause) {
    importError.value =
      cause instanceof Error ? cause.message : 'Could not read this configuration.'
  } finally {
    importInputKey.value++
  }
}
async function approveUpdate() {
  approved.value = true
  await install()
}
async function install() {
  error.value = ''
  issues.value = []
  const env: Record<string, string> = Object.create(null)
  for (const line of environment.value.split('\n').filter((line) => line.trim())) {
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    if (separator < 1 || !/^[A-Z_][A-Z0-9_]*$/.test(key) || key in env) {
      issues.value = [{ path: 'environment', message: 'Use one unique NAME=value pair per line.' }]
      return
    }
    env[key] = line.slice(separator + 1)
  }
  const parsed = createAppSchema.safeParse({
    manifest: {
      version: 1,
      requiredEnv: requiredEnv.value,
      name: name.value,
      source:
        sourceType.value === 'image'
          ? { type: 'image', image: image.value }
          : {
              type: 'git',
              url: gitURL.value,
              revision: revision.value,
              dockerfile: dockerfile.value,
            },
      port: Number(port.value),
      healthCheck: healthCheck.value,
      access: access.value,
      resources: { memoryMb: Number(memoryMb.value), cpu: Number(cpu.value) },
      volumes: volumes.value,
    },
    environment: {
      ...Object.fromEntries(
        (props.app?.environmentNames || [])
          .filter((key) => !removeEnvironment.value.includes(key))
          .map((key) => [key, '__retained__']),
      ),
      ...env,
    },
  })
  if (!parsed.success) {
    issues.value = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }))
    return
  }
  if (props.app && !approved.value) {
    confirmMaintenance.value = false
    reviewOpen.value = true
    return
  }
  approved.value = false
  pending.value = true
  try {
    const result = props.app
      ? await $fetch(`/api/apps/${props.app.id}/updates`, {
          method: 'POST',
          body: {
            ...parsed.data,
            environment: env,
            expectedGeneration: props.app.generation,
            removeEnvironment: removeEnvironment.value,
            confirmMaintenance: confirmMaintenance.value,
          },
        })
      : await $fetch('/api/apps', { method: 'POST', body: { ...parsed.data, environment: env } })
    environment.value = ''
    await navigateTo(`/apps/${props.app?.id || result.id}`)
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    pending.value = false
  }
}
</script>
<template>
  <div class="max-w-2xl">
    <NuxtLink
      :to="app ? `/apps/${app.id}` : '/'"
      class="mb-7 inline-flex items-center gap-2 text-xs text-muted-foreground"
      ><ArrowLeft :size="14" aria-hidden="true" />Back to apps</NuxtLink
    >
    <h1 class="text-3xl font-semibold tracking-tight">
      {{ app ? 'Update app' : 'Install an app' }}
    </h1>
    <p class="mt-2 text-sm text-muted-foreground">
      {{
        app
          ? 'Review settings and deploy a new version. Existing secret values stay saved unless you replace or remove them.'
          : 'Choose a source. We’ll build, check, and connect it.'
      }}
    </p>
    <aside v-if="template" class="mt-6 rounded-lg border p-4 text-sm">
      <p class="font-medium">{{ template.title }} · {{ template.version }}</p>
      <p class="mt-2 text-muted-foreground">{{ template.notes }}</p>
      <p class="mt-2 text-xs text-muted-foreground">
        The image is pinned to a reviewed version. All settings below remain editable.
      </p>
      <a
        :href="template.documentation"
        target="_blank"
        rel="noopener noreferrer"
        class="mt-2 inline-block text-xs underline"
        >App documentation</a
      >
    </aside>
    <NuxtLink v-if="!app" to="/apps/templates" class="mt-4 inline-block text-sm underline"
      >Browse app templates</NuxtLink
    >
    <div class="mt-6 rounded-lg border p-4">
      <UiLabel for="configuration-file">Import configuration</UiLabel>
      <UiInput
        id="configuration-file"
        :key="importInputKey"
        type="file"
        accept=".json,.yaml,.yml"
        class="mt-2"
        @change="importConfiguration"
      />
      <p class="mt-2 text-xs text-muted-foreground">
        Choose servitas.json or servitas.yaml from the app’s repository. Imported settings remain
        editable.
      </p>
      <p v-if="importError" role="alert" class="mt-3 whitespace-pre-wrap text-sm text-destructive">
        {{ importError }}
      </p>
      <p v-if="importNotice" role="status" class="mt-3 text-sm">{{ importNotice }}</p>
      <p v-if="repositoryError" role="alert" class="mt-3 text-sm text-destructive">
        {{ repositoryError }}
      </p>
      <div v-if="inspection" class="mt-4 space-y-3 border-t pt-4 text-sm">
        <p role="status" :class="inspection.job.status === 'failed' ? 'text-destructive' : ''">
          {{ inspection.job.message }}
        </p>
        <p class="break-all text-xs text-muted-foreground">
          {{ inspection.request.source.url }} · {{ inspection.request.source.revision }}
        </p>
        <template v-if="inspection.job.status === 'succeeded' && inspection.result">
          <p>
            {{ inspection.result.path }} · {{ inspection.result.configuration.name }} ·
            {{ inspection.result.configuration.access }} · port
            {{ inspection.result.configuration.port }}
          </p>
          <p class="text-xs text-muted-foreground">
            Applying replaces the displayed settings and selects commit
            {{ inspection.result.commit.slice(0, 12) }}. Entered secret values are kept.
          </p>
          <UiButton
            type="button"
            variant="outline"
            size="sm"
            :disabled="pending"
            @click="applyRepositoryConfiguration"
            >Apply configuration</UiButton
          >
        </template>
        <UiButton
          v-if="inspection.job.status === 'failed'"
          type="button"
          variant="outline"
          size="sm"
          :disabled="pending"
          @click="editRepositoryDetails"
          >Edit repository details</UiButton
        >
        <NuxtLink :to="`/operations/${inspection.job.id}`" class="block text-xs underline"
          >View repository operation</NuxtLink
        >
      </div>
      <p v-if="requiredEnv.length" class="mt-2 text-xs">
        Required environment variables: {{ requiredEnv.join(', ') }}.
      </p>
    </div>
    <form class="mt-8 space-y-7" @submit.prevent="install">
      <fieldset :disabled="pending" class="space-y-6">
        <div class="space-y-2">
          <UiLabel for="app-name">App name</UiLabel
          ><UiInput
            id="app-name"
            v-model="name"
            :readonly="!!app"
            placeholder="my-notes"
            required
            maxlength="63"
            :aria-invalid="!!fieldError('manifest.name')"
          />
          <p class="text-xs text-muted-foreground">
            Lowercase letters, numbers, and hyphens. This becomes part of the app URL.
          </p>
          <p v-if="fieldError('manifest.name')" class="text-xs text-destructive">
            {{ fieldError('manifest.name') }}
          </p>
        </div>
        <fieldset class="space-y-3">
          <legend class="text-sm font-medium">Source</legend>
          <div class="flex gap-5 text-sm">
            <label class="flex items-center gap-2"
              ><input
                v-model="sourceType"
                type="radio"
                value="image"
                name="source"
                class="accent-primary"
              />Container image</label
            ><label class="flex items-center gap-2"
              ><input
                v-model="sourceType"
                type="radio"
                value="git"
                name="source"
                class="accent-primary"
              />Git repository</label
            >
          </div>
        </fieldset>
        <div v-if="sourceType === 'image'" class="space-y-2">
          <UiLabel for="image">Image</UiLabel
          ><UiInput id="image" v-model="image" placeholder="nginx:alpine" required />
          <p class="text-xs text-muted-foreground">Use a public image with a tag or digest.</p>
          <p v-if="fieldError('manifest.source.image')" class="text-xs text-destructive">
            {{ fieldError('manifest.source.image') }}
          </p>
        </div>
        <div v-else class="space-y-4">
          <div class="space-y-2">
            <UiLabel for="repository">Repository URL</UiLabel
            ><UiInput
              id="repository"
              v-model="gitURL"
              type="url"
              placeholder="https://github.com/you/app.git"
              required
            />
            <p class="text-xs text-muted-foreground">
              A public HTTPS repository with a Dockerfile.
            </p>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div class="space-y-2">
              <UiLabel for="revision">Branch, tag, or commit</UiLabel
              ><UiInput id="revision" v-model="revision" required />
            </div>
            <div class="space-y-2">
              <UiLabel for="dockerfile">Dockerfile path</UiLabel
              ><UiInput id="dockerfile" v-model="dockerfile" required />
            </div>
          </div>
          <div class="space-y-2">
            <UiLabel for="configuration-path">Configuration path (optional)</UiLabel>
            <UiInput
              id="configuration-path"
              v-model="configurationPath"
              placeholder="servitas.yaml"
            />
            <p class="text-xs text-muted-foreground">
              Leave blank to find servitas.json, servitas.yaml, or servitas.yml in the repository
              root. For a subdirectory, enter its path.
            </p>
            <UiButton
              type="button"
              variant="outline"
              :disabled="
                inspecting ||
                (!!inspection && ['queued', 'running'].includes(inspection.job.status))
              "
              @click="inspectRepository"
              >{{
                inspecting
                  ? 'Queuing…'
                  : inspection && ['queued', 'running'].includes(inspection.job.status)
                    ? 'Reading configuration…'
                    : 'Read repository configuration'
              }}</UiButton
            >
          </div>
        </div>
        <div class="space-y-2">
          <UiLabel for="port">HTTP port</UiLabel
          ><UiInput
            id="port"
            v-model="port"
            type="number"
            min="1"
            max="65535"
            required
            class="max-w-36"
          />
          <p class="text-xs text-muted-foreground">
            The port the app listens on inside its container.
          </p>
        </div>
        <fieldset class="space-y-3">
          <legend class="text-sm font-medium">Access</legend>
          <label class="flex items-start gap-3 text-sm"
            ><input
              v-model="access"
              type="radio"
              value="private"
              name="access"
              class="mt-1 accent-primary"
            /><span
              >Private<span class="mt-1 block text-xs text-muted-foreground"
                >Only you, signed in through Servitas.</span
              ></span
            ></label
          ><label class="flex items-start gap-3 text-sm"
            ><input
              v-model="access"
              type="radio"
              value="public"
              name="access"
              class="mt-1 accent-primary"
            /><span
              >Public<span class="mt-1 block text-xs text-muted-foreground"
                >Anyone with the URL. The app may have its own login.</span
              ></span
            ></label
          >
        </fieldset>
        <details class="rounded-lg border p-4">
          <summary class="cursor-pointer text-sm font-medium">
            Environment, storage, and health checks
          </summary>
          <div class="mt-5 space-y-6">
            <div class="space-y-2">
              <div v-if="app?.environmentNames.length" class="mb-4 space-y-2">
                <p class="text-xs text-muted-foreground">
                  Saved variables. Check a name to remove it; enter NAME=value below to replace it.
                </p>
                <label
                  v-for="savedName in app.environmentNames"
                  :key="savedName"
                  class="flex items-center gap-2 text-sm"
                >
                  <input
                    v-model="removeEnvironment"
                    type="checkbox"
                    :value="savedName"
                    class="accent-primary"
                  />Remove {{ savedName }}
                </label>
              </div>
              <UiLabel for="environment">Environment variables</UiLabel
              ><UiTextarea
                id="environment"
                v-model="environment"
                placeholder="NAME=value"
                autocomplete="off"
                spellcheck="false"
                class="font-mono text-xs"
              />
              <p class="text-xs text-muted-foreground">
                One per line. Values are encrypted and won’t be displayed after saving.
              </p>
              <p v-if="fieldError('environment')" class="text-xs text-destructive">
                {{ fieldError('environment') }}
              </p>
            </div>
            <div>
              <p class="mb-2 text-sm font-medium">Persistent storage</p>
              <p class="mb-3 text-xs text-muted-foreground">
                Keep files across restarts. For each volume, choose its name and path inside the
                app.
              </p>
              <div
                v-for="(volume, index) in volumes"
                :key="index"
                class="mb-3 flex items-end gap-2"
              >
                <div class="min-w-0 flex-1 space-y-2">
                  <UiLabel :for="`volume-name-${index}`">Volume name</UiLabel
                  ><UiInput
                    :id="`volume-name-${index}`"
                    v-model="volume.name"
                    placeholder="data"
                    required
                  />
                </div>
                <div class="min-w-0 flex-1 space-y-2">
                  <UiLabel :for="`volume-path-${index}`">Mount path</UiLabel
                  ><UiInput
                    :id="`volume-path-${index}`"
                    v-model="volume.mountPath"
                    placeholder="/data"
                    required
                  />
                </div>
                <UiButton
                  type="button"
                  variant="ghost"
                  size="icon"
                  :aria-label="`Remove volume ${index + 1}`"
                  @click="volumes.splice(index, 1)"
                  ><X :size="15"
                /></UiButton>
              </div>
              <UiButton
                type="button"
                variant="outline"
                size="sm"
                :disabled="volumes.length >= 10"
                @click="volumes.push({ name: '', mountPath: '' })"
                ><Plus :size="14" aria-hidden="true" />Add volume</UiButton
              >
            </div>
            <div class="space-y-2">
              <UiLabel for="health">Health-check path</UiLabel
              ><UiInput id="health" v-model="healthCheck" placeholder="/health" required />
              <p class="text-xs text-muted-foreground">
                Must return a successful HTTP response within 60 seconds of starting.
              </p>
            </div>
            <div class="grid grid-cols-2 gap-4">
              <div class="space-y-2">
                <UiLabel for="memory">Memory (MB)</UiLabel
                ><UiInput
                  id="memory"
                  v-model="memoryMb"
                  type="number"
                  min="64"
                  max="65536"
                  required
                />
              </div>
              <div class="space-y-2">
                <UiLabel for="cpu">CPU cores</UiLabel
                ><UiInput
                  id="cpu"
                  v-model="cpu"
                  type="number"
                  min="0.1"
                  max="64"
                  step="0.1"
                  required
                />
              </div>
            </div>
          </div>
        </details>
      </fieldset>
      <div
        v-if="issues.length || error"
        role="alert"
        class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-destructive"
      >
        <p v-if="error">{{ error }}</p>
        <ul v-else class="list-inside list-disc">
          <li v-for="issue in issues" :key="issue.path">
            {{ issue.path.replace('manifest.', '') }}: {{ issue.message }}
          </li>
        </ul>
      </div>
      <div class="flex items-center justify-between border-t pt-5">
        <p class="text-xs text-muted-foreground">
          {{ access === 'private' ? 'Owner access only' : 'Publicly accessible once running' }}
        </p>
        <UiButton type="submit" :disabled="pending"
          >{{ pending ? 'Queuing deployment…' : app ? 'Review update' : 'Install app'
          }}<ArrowRight :size="15" aria-hidden="true"
        /></UiButton>
      </div>
    </form>
    <UiAlertDialog v-model:open="reviewOpen">
      <UiAlertDialogContent>
        <UiAlertDialogHeader>
          <UiAlertDialogTitle>Deploy changes to {{ name }}?</UiAlertDialogTitle>
          <UiAlertDialogDescription>
            {{
              needsMaintenance
                ? 'The app will stop while the replacement is checked. Existing volume data is retained. New code may change stored data.'
                : 'The current version keeps serving until its replacement passes the health check.'
            }}
          </UiAlertDialogDescription>
        </UiAlertDialogHeader>
        <dl class="space-y-3 text-sm">
          <div>
            <dt class="text-muted-foreground">Source</dt>
            <dd class="break-all">
              {{ sourceType === 'image' ? image : `${gitURL} · ${revision}` }}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Access / HTTP / health</dt>
            <dd>{{ access }} · {{ port }} · {{ healthCheck }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Limits / storage</dt>
            <dd>
              {{ memoryMb }} MB · {{ cpu }} CPU ·
              {{ volumes.map((v) => `${v.name}: ${v.mountPath}`).join(', ') || 'No volumes' }}
            </dd>
          </div>
          <div>
            <dt class="text-muted-foreground">Environment changes</dt>
            <dd>
              Set:
              {{
                environment
                  .split('\n')
                  .filter(Boolean)
                  .map((line) => line.split('=')[0])
                  .join(', ') || 'None'
              }}. Remove: {{ removeEnvironment.join(', ') || 'None' }}.
            </dd>
          </div>
        </dl>
        <label v-if="needsMaintenance" class="flex items-start gap-2 text-sm"
          ><input v-model="confirmMaintenance" type="checkbox" class="mt-1 accent-primary" />I
          understand this update needs a maintenance window and may change app data.</label
        >
        <UiAlertDialogFooter>
          <UiAlertDialogCancel>Keep editing</UiAlertDialogCancel>
          <UiAlertDialogAction
            :disabled="needsMaintenance && !confirmMaintenance"
            @click="approveUpdate"
            >Deploy update</UiAlertDialogAction
          >
        </UiAlertDialogFooter>
      </UiAlertDialogContent>
    </UiAlertDialog>
  </div>
</template>
