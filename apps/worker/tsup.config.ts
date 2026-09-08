import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/recover-platform.ts', 'src/preflight.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // node:sqlite is only available with its node: prefix.
  removeNodeProtocol: false,
  noExternal: ['@servitas/core', '@servitas/contracts'],
  // Bundled CommonJS dependencies (YAML) still require Node built-ins at runtime.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  clean: true,
})
