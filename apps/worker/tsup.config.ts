import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // node:sqlite is only available with its node: prefix.
  removeNodeProtocol: false,
  noExternal: ['@servitas/core', '@servitas/contracts'],
  clean: true,
})
