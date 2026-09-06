import { statfs } from 'node:fs/promises'
import type { DatabaseSync } from 'node:sqlite'
import { finishJob, reportProgress, renewLease, type ClaimedJob } from '@servitas/core'
import { dockerVersion } from './docker'

export async function runPlatformCheck(
  db: DatabaseSync,
  claim: ClaimedJob,
  dataDir: string,
  socketPath: string,
) {
  const timer = setInterval(() => renewLease(db, claim), 5000)
  try {
    if (!reportProgress(db, claim, 'Platform database is available.')) return
    const storage = await statfs(dataDir)
    const freeMb = Math.floor((storage.bavail * storage.bsize) / 1024 / 1024)
    if (
      !reportProgress(
        db,
        claim,
        `${freeMb.toLocaleString('en-US')} MB available for platform data.`,
      )
    )
      return
    if (freeMb < 256) {
      finishJob(
        db,
        claim,
        'failed',
        'Platform storage is almost full. Free at least 256 MB, then run the check again.',
      )
      return
    }
    if (!reportProgress(db, claim, 'Connecting to the container runtime.')) return
    const version = await dockerVersion(socketPath)
    finishJob(db, claim, 'succeeded', `Platform checks passed. Docker ${version} is available.`)
  } catch {
    finishJob(
      db,
      claim,
      'failed',
      'The platform check could not finish. Check worker storage and Docker access in the platform installation, then run it again.',
    )
  } finally {
    clearInterval(timer)
  }
}
