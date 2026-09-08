<script setup lang="ts">
import { ArrowLeft, ArrowUpRight } from '@lucide/vue'
import { appTemplates } from '@servitas/contracts/templates'
useHead({ title: 'App templates · Servitas' })
const configurationURL = (manifest: unknown) =>
  `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(manifest, null, 2) + '\n')}`
</script>
<template>
  <div>
    <NuxtLink to="/" class="mb-7 inline-flex items-center gap-2 text-xs text-muted-foreground"
      ><ArrowLeft :size="14" aria-hidden="true" />Back to apps</NuxtLink
    >
    <h1 class="text-3xl font-semibold tracking-tight">App templates</h1>
    <p class="mt-2 max-w-2xl text-sm text-muted-foreground">
      A small starter collection with private access and pinned versions. Review the settings before
      installing. App accounts are separate from your Servitas account.
    </p>
    <ul class="mt-8 divide-y border-y">
      <li v-for="template in appTemplates" :key="template.id" class="py-6">
        <div class="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 class="text-base font-medium">{{ template.title }}</h2>
            <p class="mt-1 text-sm text-muted-foreground">{{ template.description }}</p>
            <p class="mt-2 text-xs text-muted-foreground">
              {{ template.version }} · {{ template.manifest.resources.memoryMb }} MB memory limit ·
              {{ template.manifest.volumes.length ? 'Persistent data' : 'No server data' }}
            </p>
          </div>
          <UiButton variant="outline" as-child
            ><NuxtLink :to="`/apps/new?template=${template.id}`"
              >Configure {{ template.title }}</NuxtLink
            ></UiButton
          >
        </div>
        <p class="mt-3 max-w-2xl text-sm text-muted-foreground">{{ template.notes }}</p>
        <div class="mt-3 flex flex-wrap gap-5 text-xs">
          <a
            :href="template.documentation"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 underline"
            >App documentation<ArrowUpRight :size="12" aria-hidden="true"
          /></a>
          <a
            :href="configurationURL(template.manifest)"
            download="servitas.json"
            class="underline"
            :aria-label="`Download ${template.title} configuration`"
            >Download servitas.json</a
          >
        </div>
      </li>
    </ul>
    <NuxtLink to="/apps/new" class="mt-6 inline-block text-sm underline"
      >Install from your own image, repository, or configuration file</NuxtLink
    >
  </div>
</template>
