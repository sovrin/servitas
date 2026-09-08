<script setup lang="ts">
import { errorMessage } from '~/lib/format'
const route = useRoute()
const { data, error } = await useFetch(`/api/apps/${route.params.id}`)
useHead({ title: 'Update app · Servitas' })
</script>
<template>
  <p v-if="error" role="alert" class="text-destructive">{{ errorMessage(error) }}</p>
  <AppForm v-else-if="data" :app="data.app" />
</template>
