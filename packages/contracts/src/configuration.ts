import { parseDocument } from 'yaml'
import { z } from 'zod'
import { manifestSchema, createAppSchema, gitSourceSchema, type Job } from './index'

// A source can be omitted when the owner has already selected its repository in the form.
export const appConfigurationSchema = manifestSchema
  .omit({ source: true })
  .extend({
    source: manifestSchema.shape.source.optional(),
    $schema: z.url().optional(),
  })
  .strict()
export type AppConfiguration = z.infer<typeof appConfigurationSchema>
export function parseAppConfiguration(contents: string, filename: string): AppConfiguration {
  if (new TextEncoder().encode(contents).length > 65_536)
    throw new Error('Configuration files must be 64 KB or smaller.')
  let value: unknown
  if (/\.json$/i.test(filename)) value = JSON.parse(contents)
  else if (/\.ya?ml$/i.test(filename)) {
    const document = parseDocument(contents, { uniqueKeys: true, strict: true })
    if (document.errors.length) throw new Error(document.errors[0]!.message)
    // Configuration has no need for aliases, custom executable tags or object references.
    if (document.warnings.length) throw new Error(document.warnings[0]!.message)
    value = document.toJS({ maxAliasCount: 0 })
  } else throw new Error('Choose a servitas.json, servitas.yaml, or servitas.yml file.')
  const parsed = appConfigurationSchema.safeParse(value)
  if (!parsed.success)
    throw new Error(
      parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'Configuration'}: ${issue.message}`)
        .join('\n'),
    )
  const { $schema, ...config } = parsed.data
  const complete = createAppSchema.safeParse({
    manifest: { ...config, source: config.source || { type: 'image', image: 'selected-source' } },
    environment: Object.fromEntries(
      config.requiredEnv.map((name) => [name, 'required-at-deployment']),
    ),
  })
  if (!complete.success)
    throw new Error(complete.error.issues.map((issue) => issue.message).join('\n'))
  return parsed.data
}

export function configurationJSONSchema() {
  return z.toJSONSchema(appConfigurationSchema)
}

export const repositoryInspectionSchema = z
  .object({
    source: gitSourceSchema,
    path: z
      .string()
      .max(255)
      .regex(/^(?:[a-zA-Z0-9_-]+\/)*servitas\.(?:json|ya?ml)$/)
      .optional(),
    appId: z.uuid().optional(),
  })
  .strict()
export type RepositoryInspectionInput = z.infer<typeof repositoryInspectionSchema>
export interface RepositoryConfiguration {
  configuration: AppConfiguration
  path: string
  commit: string
}
export interface RepositoryInspection {
  job: Job
  request: RepositoryInspectionInput
  result: RepositoryConfiguration | null
}
