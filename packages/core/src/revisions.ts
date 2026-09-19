import type { DatabaseSync } from 'node:sqlite'
import {
  createAppSchema,
  type AppRevision,
  type UpdateAppInput,
  type RollbackAppInput,
} from '@servitas/contracts'
import { appEnvironment, getApp, insertAppJob } from './apps'
import { transaction } from './database'
import { ownsLease, type ClaimedJob } from './jobs'
import { openEnvironment, sealEnvironment } from './secrets'

const fields = `id, app_id AS appId, manifest, environment_names AS environmentNames, previous, image_id AS imageId, source_commit AS "commit",
container_id AS containerId, container_name AS containerName, phase, requires_recovery AS requiresRecovery, logs`
type Row = Omit<AppRevision, 'manifest' | 'previous' | 'requiresRecovery' | 'environmentNames'> & {
  manifest: string
  environmentNames: string
  previous: string
  requiresRecovery: number
}
function parse(row: Row): AppRevision {
  return {
    ...row,
    manifest: JSON.parse(row.manifest),
    environmentNames: JSON.parse(row.environmentNames),
    previous: JSON.parse(row.previous),
    requiresRecovery: !!row.requiresRecovery,
  }
}
export function getRevision(db: DatabaseSync, id: string) {
  const row = db.prepare(`SELECT ${fields} FROM app_revisions WHERE id = ?`).get(id) as
    | Row
    | undefined
  return row ? parse(row) : null
}
export function listRevisions(db: DatabaseSync, appId: string) {
  return (
    db
      .prepare(`SELECT ${fields} FROM app_revisions WHERE app_id = ? ORDER BY rowid DESC LIMIT 20`)
      .all(appId) as Row[]
  ).map(parse)
}
export function revisionEnvironment(db: DatabaseSync, id: string, key: Buffer, previous = false) {
  const row = db
    .prepare(
      `SELECT ${previous ? 'previous_environment' : 'environment'} AS value FROM app_revisions WHERE id = ?`,
    )
    .get(id) as { value: string }
  return openEnvironment(row.value, key)
}
export function queueUpdate(db: DatabaseSync, appId: string, input: UpdateAppInput, key: Buffer) {
  return transaction(db, () => insertUpdate(db, appId, input, key))
}
function insertUpdate(
  db: DatabaseSync,
  appId: string,
  input: UpdateAppInput,
  key: Buffer,
  pinnedImage?: { imageId: string | null; commit: string | null },
) {
  const app = getApp(db, appId)
  if (!app || app.status === 'removed') throw new Error('App not found.')
  if (app.generation !== input.expectedGeneration)
    throw new Error('This app changed. Reload its settings before updating.')
  if (
    db.prepare("SELECT 1 FROM jobs WHERE app_id = ? AND status IN ('queued','running')").get(appId)
  )
    throw new Error('An operation is already in progress for this app.')
  if (app.name !== input.manifest.name) throw new Error('The app name cannot be changed.')
  if ((app.manifest.volumes.length || input.manifest.volumes.length) && !input.confirmMaintenance)
    throw new Error('Confirm the maintenance window for this app’s persistent storage.')
  const previousEnvironment = appEnvironment(db, appId, key)
  const environment = { ...previousEnvironment }
  for (const name of input.removeEnvironment) delete environment[name]
  Object.assign(environment, input.environment)
  const parsed = createAppSchema.parse({
    manifest: input.manifest,
    environment,
  })
  const job = insertAppJob(db, appId, 'app.update', Date.now())
  db.prepare(
    `INSERT INTO app_revisions (id, app_id, manifest, environment, environment_names, previous, previous_environment, image_id, source_commit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.id,
    appId,
    JSON.stringify(parsed.manifest),
    sealEnvironment(environment, key),
    JSON.stringify(Object.keys(environment)),
    JSON.stringify({ ...app, logs: '' }),
    sealEnvironment(previousEnvironment, key),
    pinnedImage?.imageId ?? null,
    pinnedImage?.commit ?? null,
  )
  return job
}
export function queuePreviousVersion(
  db: DatabaseSync,
  appId: string,
  key: Buffer,
  input: RollbackAppInput,
) {
  return transaction(db, () => {
    const revision = listRevisions(db, appId).find(
      (r) => r.phase === 'applied' || r.requiresRecovery,
    )
    const app = getApp(db, appId)
    if (
      app &&
      revision &&
      (app.generation !== input.expectedGeneration || revision.id !== input.revisionId)
    )
      throw new Error('The recovery target changed. Reload the app before confirming recovery.')
    if (!app || !revision?.previous.imageId) throw new Error('No previous version is available.')
    if (
      (app.manifest.volumes.length || revision.previous.manifest.volumes.length) &&
      !input.confirmDataCompatibility
    )
      throw new Error(
        'Confirm that the previous version can use the current data. Rolling back code does not undo data migrations.',
      )
    return insertUpdate(
      db,
      appId,
      {
        manifest: revision.previous.manifest,
        environment: revisionEnvironment(db, revision.id, key, true),
        removeEnvironment: app.environmentNames,
        expectedGeneration: app.generation,
        confirmMaintenance: true,
      },
      key,
      { imageId: revision.previous.imageId, commit: revision.previous.commit },
    )
  })
}
export function updateRevision(
  db: DatabaseSync,
  claim: ClaimedJob,
  changes: Partial<
    Pick<
      AppRevision,
      'phase' | 'imageId' | 'commit' | 'containerId' | 'containerName' | 'requiresRecovery' | 'logs'
    >
  >,
) {
  return transaction(db, () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
    const columns = {
      phase: 'phase',
      imageId: 'image_id',
      commit: 'source_commit',
      containerId: 'container_id',
      containerName: 'container_name',
      requiresRecovery: 'requires_recovery',
      logs: 'logs',
    }
    const entries = Object.entries(changes) as [keyof typeof columns, string | boolean | null][]
    if (entries.length)
      db.prepare(
        `UPDATE app_revisions SET ${entries.map(([key]) => `${columns[key]} = ?`).join(', ')} WHERE id = ?`,
      ).run(
        ...entries.map(([, value]) => (typeof value === 'boolean' ? Number(value) : value)),
        claim.job.id,
      )
  })
}
// The active settings, route target and revision outcome change in one fenced transaction.
export function activateRevision(db: DatabaseSync, claim: ClaimedJob) {
  transaction(db, () => {
    if (!ownsLease(db, claim)) throw new Error('The operation lease has expired.')
    const revision = getRevision(db, claim.job.id)!
    if (revision.phase === 'applied') return
    if (
      revision.phase !== 'started' ||
      !revision.imageId ||
      !revision.containerId ||
      !revision.containerName
    )
      throw new Error('A replacement must be started and identified before activation.')
    const environment = (
      db.prepare('SELECT environment FROM app_revisions WHERE id = ?').get(revision.id) as {
        environment: string
      }
    ).environment
    db.prepare(
      `UPDATE apps SET manifest = ?, environment = ?, environment_names = ?, container_id = ?, container_name = ?, image_id = ?, source_commit = ?,
      status = 'running', desired_state = 'running', generation = generation + 1, message = 'Update applied. App is running.', logs = ?, logs_at = ? WHERE id = ?`,
    ).run(
      JSON.stringify(revision.manifest),
      environment,
      JSON.stringify(revision.environmentNames),
      revision.containerId,
      revision.containerName,
      revision.imageId,
      revision.commit,
      revision.logs,
      Date.now(),
      revision.appId,
    )
    db.prepare('UPDATE app_revisions SET requires_recovery = 0 WHERE app_id = ?').run(
      revision.appId,
    )
    db.prepare("UPDATE app_revisions SET phase = 'applied' WHERE id = ?").run(revision.id)
    if (revision.manifest.access !== revision.previous.manifest.access) {
      db.prepare('DELETE FROM app_sessions WHERE app_id = ?').run(revision.appId)
      db.prepare('DELETE FROM app_grants WHERE app_id = ?').run(revision.appId)
    }
  })
}

export function queueRetryUpdate(db: DatabaseSync, appId: string, key: Buffer) {
  return transaction(db, () => {
    const revision = listRevisions(db, appId)[0]
    const app = getApp(db, appId)
    if (!app || revision?.phase !== 'failed') throw new Error('There is no failed update to retry.')
    return insertUpdate(
      db,
      appId,
      {
        manifest: revision.manifest,
        environment: revisionEnvironment(db, revision.id, key),
        removeEnvironment: app.environmentNames,
        expectedGeneration: app.generation,
        confirmMaintenance: true,
      },
      key,
      { imageId: revision.imageId, commit: revision.commit },
    )
  })
}
