import { defineConfig } from 'oxfmt'

// Formatting rules for the whole workspace, carried over from the previous
// Prettier setup. oxfmt also honours .gitignore, so only the tracked files it
// should skip are listed here.
export default defineConfig({
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 100,
  // Keep the hand-curated key order in every package.json.
  sortPackageJson: false,
  ignorePatterns: ['pnpm-lock.yaml'],
})
