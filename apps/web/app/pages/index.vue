<script setup lang="ts">
import { Boxes, ArrowRight, Check } from '@lucide/vue'
useHead({ title: 'Apps · Servitas' })
</script>

<template>
  <div>
    <div class="mb-9">
      <p class="mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        Your workspace
      </p>
      <h1 class="text-3xl font-semibold tracking-tight">Apps</h1>
      <p class="mt-2 text-sm text-muted-foreground">
        A home for the tools you use and the things you build.
      </p>
    </div>
    <div class="flex items-center justify-between border-b pb-3 text-sm">
      <span class="font-medium">Your apps <span class="ml-2 text-muted-foreground">0</span></span
      ><span class="text-xs text-muted-foreground">Single-server workspace</span>
    </div>
    <section
      class="flex min-h-80 flex-col items-center justify-center border-b px-5 py-14 text-center"
      aria-labelledby="empty-title"
    >
      <div class="mb-5 flex size-12 items-center justify-center rounded-xl border bg-white">
        <Boxes :size="22" class="text-muted-foreground" aria-hidden="true" />
      </div>
      <h2 id="empty-title" class="text-lg font-medium tracking-tight">Your cloud starts here.</h2>
      <p class="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        The platform foundation is ready. App installation is the next milestone; first, check that
        your platform is connected.
      </p>
      <UiButton as-child class="mt-6"
        ><NuxtLink to="/platform"
          >Check your platform<ArrowRight :size="15" aria-hidden="true" /></NuxtLink
      ></UiButton>
    </section>
    <div class="mt-8 grid gap-6 text-sm sm:grid-cols-2">
      <div>
        <p class="mb-2 flex items-center gap-2 font-medium">
          <Check :size="15" class="text-primary" aria-hidden="true" />Foundation in place
        </p>
        <p class="leading-relaxed text-muted-foreground">
          Owner access, persistent operations, and worker health checks.
        </p>
      </div>
      <div>
        <p class="mb-2 font-medium">Up next: your first app</p>
        <p class="leading-relaxed text-muted-foreground">
          Install from a container image or Git, then manage it here.
        </p>
      </div>
    </div>
  </div>
</template>
