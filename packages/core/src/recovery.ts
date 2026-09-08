import type { DatabaseSync } from 'node:sqlite'
import { transaction } from './database'

// Offline platform recovery only. Restored metadata must never start apps on empty host volumes.
export function preparePlatformRecovery(db: DatabaseSync) {
  return transaction(db, () => {
    const now = Date.now()
    db.prepare(
      "INSERT INTO job_events(job_id,message,created_at) SELECT id,'Operation cancelled during platform recovery.',? FROM jobs WHERE status IN ('queued','running')",
    ).run(now)
    db.prepare(
      "UPDATE jobs SET status='failed',message='Operation cancelled during platform recovery.',finished_at=?,lease_token=NULL,lease_until=NULL WHERE status IN ('queued','running')",
    ).run(now)
    db.exec(
      "DELETE FROM app_grants; DELETE FROM app_sessions; DELETE FROM sessions; DELETE FROM worker_heartbeat; UPDATE backup_schedules SET enabled=0; UPDATE apps SET status='removed',desired_state='removed',container_id=NULL,container_name=NULL,message='Platform recovered. Restore this app from Backups before starting.';",
    )
  })
}
