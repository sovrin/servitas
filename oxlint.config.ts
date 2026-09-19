import { defineConfig } from 'oxlint'

// Linting rules for the whole workspace. The TypeScript, unicorn, and oxc
// plugins are on by default; the correctness category is treated as an error.
export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc'],
  categories: { correctness: 'error' },
  env: { builtin: true },
})
