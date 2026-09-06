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
      z
        .object({
          type: z.literal('git'),
          url: z.url({ protocol: /^https$/ }),
          revision: z.string().min(1).max(255),
          dockerfile: z
            .string()
            .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[a-zA-Z0-9_./-]+$/)
            .default('Dockerfile'),
        })
        .strict(),
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
export const jobKindSchema = z.literal('platform.check')
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
