import { z } from 'zod'

export const ownerCredentialsSchema = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    password: z.string().min(12, 'Use at least 12 characters.').max(256),
  })
  .strict()

export const setupSchema = ownerCredentialsSchema.extend({ token: z.string().min(32).max(256) })

export const gitSourceSchema = z
  .object({
    type: z.literal('git'),
    url: z.url({ protocol: /^https$/ }).refine((value) => {
      try {
        const url = new URL(value)
        return !url.username && !url.password
      } catch {
        return false
      }
    }, 'Use a public repository URL without credentials.'),
    revision: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) => !value.startsWith('-') && !/[\s~^:?*[\\]/.test(value),
        'Use a branch, tag, or full commit SHA.',
      ),
    dockerfile: z
      .string()
      .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+$/)
      .default('Dockerfile'),
  })
  .strict()

export const manifestSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .max(63)
      .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    source: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('image'),
          image: z
            .string()
            .min(1)
            .max(255)
            .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/@:-]*$/),
        })
        .strict(),
      gitSourceSchema,
    ]),
    port: z.number().int().min(1).max(65535),
    healthCheck: z.string().startsWith('/').max(2048).default('/'),
    access: z.enum(['private', 'public']).default('private'),
    resources: z
      .object({ memoryMb: z.number().int().min(64).max(65536), cpu: z.number().min(0.1).max(64) })
      .strict()
      .default({ memoryMb: 256, cpu: 1 }),
    volumes: z
      .array(
        z
          .object({
            name: z.string().regex(/^[a-z][a-z0-9-]*$/),
            mountPath: z.string().regex(/^\/(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_/-]+$/),
          })
          .strict(),
      )
      .max(10)
      .default([]),
    requiredEnv: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
      .max(100)
      .default([]),
  })
  .strict()

export type AppManifest = z.infer<typeof manifestSchema>
export const jobKindSchema = z.enum([
  'platform.check',
  'repository.inspect',
  'backup.check',
  'platform.backup',
  'app.backup',
  'app.restore',
  'app.deploy',
  'app.start',
  'app.stop',
  'app.remove',
  'app.update',
  'app.restart',
])
export const appActionSchema = z.enum(['deploy', 'start', 'stop', 'remove', 'restart'])
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export interface Job {
  id: string
  kind: z.infer<typeof jobKindSchema>
  status: JobStatus
  createdAt: number
  startedAt: number | null
  finishedAt: number | null
  attempts: number
  message: string
  appId: string | null
}
export interface JobEvent {
  id: number
  jobId: string
  message: string
  createdAt: number
}
export interface AuthStatus {
  setupRequired: boolean
  owner: { email: string } | null
}
export interface PlatformStatus {
  worker: { online: boolean; lastSeenAt: number | null }
  jobs: Job[]
}

export const createAppSchema = z
  .object({
    manifest: manifestSchema,
    environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096)).default({}),
  })
  .strict()
  .superRefine(({ manifest, environment }, context) => {
    if (Object.keys(environment).length > 100)
      context.addIssue({
        code: 'custom',
        path: ['environment'],
        message: 'Use at most 100 environment variables.',
      })
    for (const name of manifest.requiredEnv)
      if (!(name in environment))
        context.addIssue({ code: 'custom', path: ['environment'], message: `${name} is required.` })
    if (
      new Set(manifest.volumes.map((v) => v.name)).size !== manifest.volumes.length ||
      new Set(manifest.volumes.map((v) => v.mountPath)).size !== manifest.volumes.length
    )
      context.addIssue({
        code: 'custom',
        path: ['manifest', 'volumes'],
        message: 'Volume names and mount paths must be unique.',
      })
    if (!/^\/(?!\/)[^\s?#]*$/.test(manifest.healthCheck))
      context.addIssue({
        code: 'custom',
        path: ['manifest', 'healthCheck'],
        message: 'Use a local HTTP path, such as /health.',
      })
  })
export type CreateAppInput = z.infer<typeof createAppSchema>
export type AppStatus =
  'pending' | 'deploying' | 'running' | 'stopped' | 'failed' | 'removed' | 'unknown'
export interface HostedApp {
  id: string
  name: string
  manifest: AppManifest
  environmentNames: string[]
  status: AppStatus
  desiredState: 'running' | 'stopped' | 'removed'
  createdAt: number
  containerId: string | null
  containerName: string | null
  volumeSet: string | null
  generation: number
  imageId: string | null
  commit: string | null
  message: string
  logs: string
  logsAt: number | null
  lastSeenAt: number | null
}

export const jobLabels: Record<Job['kind'], string> = {
  'platform.check': 'Platform check',
  'repository.inspect': 'Read repository configuration',
  'backup.check': 'Check backup destination',
  'platform.backup': 'Back up platform',
  'app.backup': 'Back up app',
  'app.restore': 'Restore app',
  'app.deploy': 'Deploy app',
  'app.start': 'Start app',
  'app.stop': 'Stop app',
  'app.remove': 'Remove app',
  'app.update': 'Update app',
  'app.restart': 'Restart app',
}

export const updateAppSchema = z
  .object({
    manifest: manifestSchema,
    environment: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096)).default({}),
    removeEnvironment: z
      .array(z.string().regex(/^[A-Z_][A-Z0-9_]*$/))
      .max(100)
      .default([]),
    expectedGeneration: z.number().int().nonnegative(),
    confirmMaintenance: z.boolean().default(false),
  })
  .strict()
export type UpdateAppInput = z.infer<typeof updateAppSchema>
export interface AppRevision {
  environmentNames: string[]
  id: string
  appId: string
  manifest: AppManifest
  previous: HostedApp
  imageId: string | null
  commit: string | null
  containerId: string | null
  containerName: string | null
  phase: 'queued' | 'building' | 'maintenance' | 'started' | 'applied' | 'failed'
  requiresRecovery: boolean
  logs: string
}

export const rollbackAppSchema = z
  .object({
    confirmDataCompatibility: z.boolean().default(false),
    revisionId: z.uuid(),
    expectedGeneration: z.number().int().nonnegative(),
  })
  .strict()

export type RollbackAppInput = z.infer<typeof rollbackAppSchema>
