import { z } from 'zod'
import { createAppSchema, type HostedApp, type Job } from './index'

export const backupDestinationSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    endpoint: z.url({ protocol: /^https?$/ }).refine((value) => {
      try {
        const url = new URL(value)
        return !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      } catch {
        return false
      }
    }, 'Use an S3 endpoint origin without credentials or a path.'),
    bucket: z
      .string()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
    prefix: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/)
      .default('servitas'),
    region: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default('us-east-1'),
    accessKey: z.string().min(1).max(256),
    secretKey: z.string().min(1).max(4096),
    password: z
      .string()
      .min(20, 'Use at least 20 characters for the backup recovery password.')
      .max(1024),
    confirmRecoveryPasswordSaved: z.literal(
      true,
      'Save the recovery password outside this server.',
    ),
    allowInsecureHTTP: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) => !value.endpoint.startsWith('http:') || value.allowInsecureHTTP,
    'Confirm unencrypted HTTP for this endpoint.',
  )
export type BackupDestinationInput = z.infer<typeof backupDestinationSchema>
export type BackupDestination = Omit<
  BackupDestinationInput,
  'accessKey' | 'secretKey' | 'password' | 'confirmRecoveryPasswordSaved'
> & { id: string; checkedAt: number | null; message: string }
export const backupRequestSchema = z
  .object({ destinationId: z.uuid(), confirmMaintenance: z.literal(true) })
  .strict()
export const restoreRequestSchema = z
  .object({
    backupId: z.uuid(),
    expectedGeneration: z.number().int().nonnegative(),
    confirmName: z.string().min(1),
    confirmOverwrite: z.literal(true),
  })
  .strict()
export const backupScheduleSchema = z
  .object({
    destinationId: z.uuid(),
    enabled: z.boolean(),
    hourUTC: z.number().int().min(0).max(23),
    confirmMaintenance: z.literal(true),
  })
  .strict()
export interface BackupSchedule {
  appId: string
  destinationId: string
  enabled: boolean
  hourUTC: number
  nextRunAt: number
}
export interface AppBackup {
  id: string
  appId: string
  appName: string
  destinationId: string
  snapshotId: string
  createdAt: number
  manifest: HostedApp['manifest']
  commit: string | null
}
export const backupMetadataSchema = z
  .object({
    version: z.literal(1),
    appId: z.uuid(),
    backupId: z.uuid(),
    createdAt: z.number().int().positive(),
    configuration: createAppSchema,
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    imageReference: z
      .string()
      .max(255)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:-]*@sha256:[a-f0-9]{64}$/)
      .nullable()
      .default(null),
    commit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
  })
  .strict()
export type BackupMetadata = z.infer<typeof backupMetadataSchema>
export interface BackupOperation {
  job: Job
  destinationId: string
  backupId: string | null
  phase:
    | 'queued'
    | 'stopping'
    | 'uploading'
    | 'saved'
    | 'restoring'
    | 'restored'
    | 'starting'
    | 'applied'
  previous: HostedApp | null
  snapshotId: string | null
  containerId: string | null
  containerName: string | null
  imageId: string | null
}

export const backupDestinationActionSchema = z
  .object({ action: z.enum(['check', 'backup-platform']) })
  .strict()
export const backupCredentialsSchema = z
  .object({
    accessKey: z.string().min(1).max(256),
    secretKey: z.string().min(1).max(4096),
    password: z.string().min(20).max(1024),
    confirmRecoveryPasswordSaved: z.literal(true),
  })
  .strict()
