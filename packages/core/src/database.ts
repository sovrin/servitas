import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function openDatabase(dataDir: string) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(resolve(dataDir, 'servitas.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
  transaction(db, () => {
    const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
      user_version: number
    }
    if (version > 5) throw new Error('This database requires a newer version of Servitas.')
    if (version === 5) return
    if (version === 0)
      db.exec(`
      CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK (id = 1), email TEXT NOT NULL, password_hash TEXT NOT NULL);
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE rate_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, resets_at INTEGER NOT NULL);
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind = 'platform.check'),
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
        message TEXT NOT NULL
      );
      CREATE INDEX jobs_pending ON jobs(status, created_at);
      CREATE TABLE job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id),
        message TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE worker_heartbeat (id INTEGER PRIMARY KEY CHECK (id = 1), last_seen_at INTEGER NOT NULL);
      PRAGMA user_version = 1;
    `)
    if (version < 2)
      db.exec(`
      CREATE TABLE apps (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, manifest TEXT NOT NULL,
        environment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        desired_state TEXT NOT NULL DEFAULT 'running', created_at INTEGER NOT NULL,
        container_id TEXT, image_id TEXT, source_commit TEXT,
        message TEXT NOT NULL DEFAULT 'Waiting for deployment.',
        logs TEXT NOT NULL DEFAULT '', logs_at INTEGER, last_seen_at INTEGER
      );
      CREATE TABLE jobs_v2 (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('platform.check','app.deploy','app.start','app.stop','app.remove')),
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
        message TEXT NOT NULL, app_id TEXT REFERENCES apps(id)
      );
      INSERT INTO jobs_v2 SELECT *, NULL FROM jobs;
      CREATE TABLE job_events_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs_v2(id),
        message TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO job_events_v2 SELECT * FROM job_events;
      DROP TABLE job_events;
      DROP TABLE jobs;
      ALTER TABLE jobs_v2 RENAME TO jobs;
      ALTER TABLE job_events_v2 RENAME TO job_events;
      CREATE INDEX jobs_pending ON jobs(status, created_at);
      CREATE UNIQUE INDEX one_app_operation ON jobs(app_id) WHERE app_id IS NOT NULL AND status IN ('queued','running');
      CREATE TABLE app_grants (token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id), session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      CREATE TABLE app_sessions (token_hash TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id), session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
      PRAGMA user_version = 2;
    `)
    if (version < 3)
      db.exec(`
      ALTER TABLE apps ADD COLUMN container_name TEXT;
      ALTER TABLE apps ADD COLUMN environment_names TEXT NOT NULL DEFAULT '[]';
      UPDATE apps SET environment_names = json_extract(manifest, '$.requiredEnv'), manifest = json_set(manifest, '$.requiredEnv', json('[]'));
      ALTER TABLE apps ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE jobs_v3 (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('platform.check','app.deploy','app.start','app.stop','app.remove','app.update','app.restart')),
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
        message TEXT NOT NULL, app_id TEXT REFERENCES apps(id)
      );
      INSERT INTO jobs_v3 SELECT * FROM jobs;
      CREATE TABLE job_events_v3 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs_v3(id),
        message TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO job_events_v3 SELECT * FROM job_events;
      DROP TABLE job_events;
      DROP TABLE jobs;
      ALTER TABLE jobs_v3 RENAME TO jobs;
      ALTER TABLE job_events_v3 RENAME TO job_events;
      CREATE INDEX jobs_pending ON jobs(status, created_at);
      CREATE UNIQUE INDEX one_app_operation ON jobs(app_id) WHERE app_id IS NOT NULL AND status IN ('queued','running');
      CREATE TABLE app_revisions (
        id TEXT PRIMARY KEY REFERENCES jobs(id), app_id TEXT NOT NULL REFERENCES apps(id),
        manifest TEXT NOT NULL, environment TEXT NOT NULL, environment_names TEXT NOT NULL DEFAULT '[]', previous TEXT NOT NULL, previous_environment TEXT NOT NULL,
        image_id TEXT, source_commit TEXT, container_id TEXT, container_name TEXT,
        phase TEXT NOT NULL DEFAULT 'queued', requires_recovery INTEGER NOT NULL DEFAULT 0, logs TEXT NOT NULL DEFAULT ''
      );
      PRAGMA user_version = 3;
    `)
    // Keep job kinds in the shared contract. Rebuilding a checked enum for every new
    // operation would repeatedly migrate all tables referencing jobs.
    if (version < 4)
      db.exec(`
      CREATE TABLE jobs_v4 (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
        created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until INTEGER,
        message TEXT NOT NULL, app_id TEXT REFERENCES apps(id)
      );
      INSERT INTO jobs_v4 SELECT * FROM jobs;
      CREATE TABLE job_events_v4 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs_v4(id),
        message TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      INSERT INTO job_events_v4 SELECT * FROM job_events;
      CREATE TABLE app_revisions_v4 (
        id TEXT PRIMARY KEY REFERENCES jobs_v4(id), app_id TEXT NOT NULL REFERENCES apps(id),
        manifest TEXT NOT NULL, environment TEXT NOT NULL, environment_names TEXT NOT NULL DEFAULT '[]', previous TEXT NOT NULL, previous_environment TEXT NOT NULL,
        image_id TEXT, source_commit TEXT, container_id TEXT, container_name TEXT,
        phase TEXT NOT NULL DEFAULT 'queued', requires_recovery INTEGER NOT NULL DEFAULT 0, logs TEXT NOT NULL DEFAULT ''
      );
      INSERT INTO app_revisions_v4 SELECT * FROM app_revisions;
      DROP TABLE app_revisions;
      DROP TABLE job_events;
      DROP TABLE jobs;
      ALTER TABLE jobs_v4 RENAME TO jobs;
      ALTER TABLE job_events_v4 RENAME TO job_events;
      ALTER TABLE app_revisions_v4 RENAME TO app_revisions;
      CREATE INDEX jobs_pending ON jobs(status, created_at);
      CREATE UNIQUE INDEX one_app_operation ON jobs(app_id) WHERE app_id IS NOT NULL AND status IN ('queued','running');
      CREATE TABLE repository_inspections (
        id TEXT PRIMARY KEY REFERENCES jobs(id), request TEXT NOT NULL, source_commit TEXT, result TEXT
      );
      PRAGMA user_version = 4;
    `)
    db.exec(`
      ALTER TABLE apps ADD COLUMN volume_set TEXT;
      UPDATE app_revisions SET previous = json_set(previous, '$.volumeSet', NULL);
      CREATE TABLE backup_destinations (id TEXT PRIMARY KEY, configuration TEXT NOT NULL, secrets TEXT NOT NULL, checked_at INTEGER, message TEXT NOT NULL DEFAULT 'Not checked.');
      CREATE TABLE app_backups (id TEXT PRIMARY KEY, app_id TEXT NOT NULL, destination_id TEXT NOT NULL REFERENCES backup_destinations(id), snapshot_id TEXT NOT NULL, created_at INTEGER NOT NULL, metadata TEXT NOT NULL, UNIQUE(destination_id, snapshot_id));
      CREATE TABLE backup_operations (id TEXT PRIMARY KEY REFERENCES jobs(id), destination_id TEXT NOT NULL REFERENCES backup_destinations(id), backup_id TEXT, phase TEXT NOT NULL DEFAULT 'queued', previous TEXT, snapshot_id TEXT, container_id TEXT, container_name TEXT, image_id TEXT);
      CREATE TABLE backup_schedules (app_id TEXT PRIMARY KEY REFERENCES apps(id), destination_id TEXT NOT NULL REFERENCES backup_destinations(id), enabled INTEGER NOT NULL, hour_utc INTEGER NOT NULL, next_run_at INTEGER NOT NULL);
      PRAGMA user_version = 5;
    `)
  })
  return db
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = action()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
