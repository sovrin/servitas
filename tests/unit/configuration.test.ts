import { expect, test } from 'vitest'
import { parseAppConfiguration } from '../../packages/contracts/src/configuration'
import { createAppSchema } from '../../packages/contracts/src/index'

const config = { version: 1, name: 'notes', port: 3000, requiredEnv: ['API_KEY'] }
test('JSON and YAML imports share defaults, support a selected repository, and keep secret values out of files', () => {
  const json = parseAppConfiguration(JSON.stringify(config), 'servitas.json')
  const yaml = parseAppConfiguration(
    'version: 1\nname: notes\nport: 3000\nrequiredEnv:\n  - API_KEY\n',
    'servitas.yaml',
  )
  expect(yaml).toEqual(json)
  expect(json.access).toBe('private')
  expect(json.source).toBeUndefined()
  expect(() =>
    parseAppConfiguration(
      JSON.stringify({ ...config, environment: { API_KEY: 'secret' } }),
      'servitas.json',
    ),
  ).toThrow('environment')
  expect(
    createAppSchema.safeParse({
      manifest: { ...json, source: { type: 'image', image: 'nginx:alpine' } },
      environment: {},
    }).success,
  ).toBe(false)
})
test('rejects malformed, ambiguous, aliased, and oversized configuration', () => {
  expect(() => parseAppConfiguration('{', 'servitas.json')).toThrow()
  expect(() => parseAppConfiguration('version: 1\nversion: 2', 'servitas.yaml')).toThrow()
  expect(() => parseAppConfiguration('name: &name notes\nother: *name', 'servitas.yaml')).toThrow()
  expect(() => parseAppConfiguration('x'.repeat(65537), 'servitas.json')).toThrow('64 KB')
  expect(() =>
    parseAppConfiguration('name: !!js/function function() {}', 'servitas.yaml'),
  ).toThrow()
})
