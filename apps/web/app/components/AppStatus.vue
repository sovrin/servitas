<script setup lang="ts">
import type { AppStatus } from '@servitas/contracts'
defineProps<{ status: AppStatus }>()
const labels: Record<AppStatus, string> = {
  pending: 'Queued',
  deploying: 'Deploying',
  running: 'Running',
  stopped: 'Stopped',
  failed: 'Failed',
  removed: 'Removed',
  unknown: 'Needs attention',
}
</script>
<template>
  <UiBadge
    variant="outline"
    :class="{
      'border-emerald-200 bg-emerald-50 text-emerald-800': status === 'running',
      'border-red-200 bg-red-50 text-red-800': status === 'failed',
      'border-amber-200 bg-amber-50 text-amber-900': ['pending', 'deploying', 'unknown'].includes(
        status,
      ),
    }"
    >{{ labels[status] }}</UiBadge
  >
</template>
