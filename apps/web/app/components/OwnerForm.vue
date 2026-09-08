<script setup lang="ts">
import { ArrowRight, LockKeyhole } from '@lucide/vue'
import { errorMessage } from '~/lib/format'
const props = defineProps<{ setup?: boolean }>()
const route = useRoute()
const email = ref('')
const password = ref('')
const token = ref('')
const error = ref('')
const pending = ref(false)
async function submit() {
  pending.value = true
  error.value = ''
  try {
    await $fetch(props.setup ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      body: {
        email: email.value,
        password: password.value,
        ...(props.setup ? { token: token.value.trim() } : {}),
      },
    })
    password.value = ''
    token.value = ''
    const next =
      typeof route.query.next === 'string' && /^\/open\/[a-f0-9-]{36}$/.test(route.query.next)
        ? route.query.next
        : '/'
    if (next.startsWith('/open/')) await navigateTo(next, { external: true })
    else await navigateTo('/')
  } catch (cause) {
    error.value = errorMessage(cause)
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <main class="flex min-h-screen flex-col items-center justify-center px-5 py-12">
    <div class="w-full max-w-sm">
      <BrandMark class="mb-12 text-lg" />
      <div class="mb-8">
        <p class="mb-3 text-xs font-medium uppercase tracking-widest text-muted-foreground">
          {{ setup ? 'A place for your apps' : 'Your personal cloud' }}
        </p>
        <h1 class="text-2xl font-semibold tracking-tight">
          {{ setup ? 'Make yourself at home.' : 'Welcome back.' }}
        </h1>
        <p class="mt-3 text-sm leading-relaxed text-muted-foreground">
          {{
            setup
              ? 'Create the owner account to start managing your cloud.'
              : 'Sign in to manage your apps and platform.'
          }}
        </p>
      </div>
      <form class="space-y-5" @submit.prevent="submit">
        <div class="space-y-2">
          <UiLabel for="email">Email</UiLabel
          ><UiInput
            id="email"
            v-model="email"
            type="email"
            autocomplete="username"
            placeholder="you@example.com"
            required
            maxlength="254"
            :disabled="pending"
          />
        </div>
        <div class="space-y-2">
          <UiLabel for="password">Password</UiLabel
          ><UiInput
            id="password"
            v-model="password"
            type="password"
            :autocomplete="setup ? 'new-password' : 'current-password'"
            required
            minlength="12"
            maxlength="256"
            :disabled="pending"
            :aria-describedby="setup ? 'password-help' : undefined"
          />
          <p v-if="setup" id="password-help" class="text-xs text-muted-foreground">
            At least 12 characters. A passphrase works well.
          </p>
        </div>
        <div v-if="setup" class="space-y-2">
          <UiLabel for="token">Installation key</UiLabel
          ><UiInput
            id="token"
            v-model="token"
            type="password"
            autocomplete="off"
            required
            minlength="32"
            maxlength="256"
            :disabled="pending"
            aria-describedby="token-help"
          />
          <p id="token-help" class="text-xs leading-relaxed text-muted-foreground">
            Use the key provided during platform installation. It protects this initial setup.
          </p>
        </div>
        <p
          v-if="error"
          role="alert"
          class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-destructive"
        >
          {{ error }}
        </p>
        <UiButton type="submit" class="w-full" :disabled="pending"
          >{{ pending ? 'Please wait…' : setup ? 'Create owner account' : 'Sign in'
          }}<ArrowRight v-if="!pending" :size="15" aria-hidden="true"
        /></UiButton>
      </form>
      <p
        class="mt-8 flex items-start gap-2 border-t pt-5 text-xs leading-relaxed text-muted-foreground"
      >
        <LockKeyhole :size="14" class="mt-0.5 shrink-0" aria-hidden="true" />{{
          setup
            ? 'One owner. Your server. Credentials stay on this platform.'
            : 'Access is limited to the platform owner.'
        }}
      </p>
    </div>
  </main>
</template>
