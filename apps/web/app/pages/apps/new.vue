<script setup lang="ts">
import { appTemplates } from '@servitas/contracts/templates'
useHead({ title: 'Install app · Servitas' })
const route = useRoute()
const template = computed(() => appTemplates.find((item) => item.id === route.query.template))
</script>
<template>
  <div v-if="route.query.template && !template" role="alert">
    <p>This app template is unavailable.</p>
    <NuxtLink to="/apps/templates" class="mt-3 inline-block underline"
      >Browse app templates</NuxtLink
    >
  </div>
  <AppForm v-else :key="template?.id || 'custom'" :template="template" />
</template>
