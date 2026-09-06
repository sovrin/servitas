<script setup lang="ts">
import type { JobStatus } from '@servitas/contracts'
defineProps<{ status: JobStatus }>()
const labels = { queued: 'Queued', running: 'Running', succeeded: 'Passed', failed: 'Failed' }
</script>

<template>
  <UiBadge
    variant="outline"
    :class="{
      'border-emerald-200 bg-emerald-50 text-emerald-800': status === 'succeeded',
      'border-red-200 bg-red-50 text-red-800': status === 'failed',
      'border-amber-200 bg-amber-50 text-amber-900': status === 'running',
    }"
  >
    {{ labels[status] }}
  </UiBadge>
</template>
