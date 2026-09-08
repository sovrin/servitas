# Backups and restores

Open **Backups** in the main navigation, or from an app’s detail page. Configure an existing S3-compatible bucket on another server or provider. Use a dedicated repository prefix and credentials that can read, write, list, and delete objects there. Servitas initializes an encrypted restic repository when none exists. HTTPS is the default; HTTP requires explicit acknowledgement because storage credentials are not protected by TLS.

Choose a strong recovery password and save it outside the server before submitting the form. Existing repositories require their original password. Servitas encrypts stored credentials with the platform encryption key and never returns them through its API. **Update credentials** replaces the saved connection credentials; it does not change the repository’s encryption password.

**Check and load backups** verifies repository metadata and imports saved app snapshots into the browser. This also finds backups after reconnecting an existing repository to a recovered platform and removes stale repository locks. Active locks are preserved. Only snapshots whose transfer completed successfully become restore points; incomplete transfers remain excluded even after rediscovery. Restic 0.19.1 provides encrypted, authenticated storage and deduplication. [Repository documentation](https://restic.readthedocs.io/en/stable/030_preparing_a_new_repo.html)

## Back up an app

Select an app and a checked destination, acknowledge its maintenance window, and choose **Back up app**. The worker withdraws traffic and stops its containers before reading persistent volumes. The app must shut down gracefully within 30 seconds; a forced kill causes the backup to fail. Backups include the app’s effective settings, environment values, recorded Git commit or image identity, and all currently configured named volumes. App data kept outside those volumes is not backed up.

The app stays stopped while restic encrypts and uploads its data. After the snapshot is saved, Servitas restores the app’s previous running/stopped state, then saves a platform recovery checkpoint to the same destination. An app snapshot can remain available even if restarting the app or saving the platform checkpoint fails; operation status reports the failure separately.

Enable a **Daily schedule** and choose its hour in UTC. The acknowledgement also permits scheduled maintenance. A busy app waits; missed days do not create a backlog. Job acceptance and advancement of the next due time happen together in SQLite, preventing duplicate jobs after a worker restart. Schedules pause after offline platform recovery.

All snapshots are retained. This preview displays up to 500 recent app backups and supports discovery of up to 500 app snapshots per destination. Automatic retention/pruning is not implemented. Check destination capacity as backups accumulate.

## Restore an app

Choose a saved backup, review its date, app name, access mode, and volumes, then type the app name and confirm replacement of its data and settings. Confirmation is bound to that backup and the app’s current settings generation. A stale confirmation is rejected.

Restic restores and verifies data into new, separately named volumes. Servitas stops the current app only when it is ready to check the restored version. The saved environment and deployment settings are applied together with the new storage. A healthy restored app becomes active; original volumes and containers are retained. Failed restores leave original volumes untouched and attempt to resume the prior running app. Interrupted operations adopt their existing helpers and candidate containers instead of starting duplicate work.

This restores data as well as code/configuration; it differs from **Recover previous version**, which changes code/settings while keeping current data. Restoring a backup can restore an older public/private access choice, which is shown before confirmation. Removed apps can also be restored from their saved backups.

On a new host, registry images are pulled by their saved digest. Git apps are rebuilt from their recorded commit; the repository and any build dependencies must still be available. Container images themselves are not stored in the backup. Pin Dockerfile base images and downloaded dependencies if reproducible rebuilding is required.

Restoring into separate volumes avoids exposing a partly restored filesystem. Restic also verifies restored file contents. [Restore documentation](https://restic.readthedocs.io/en/stable/050_restore.html)

## Platform checkpoints

**Back up platform** saves the owner account, consistent SQLite metadata, original platform encryption key, and installation origin settings. Every successful app backup also attempts this checkpoint. It does not contain app volumes or Caddy certificates: app snapshots hold the volumes, and Caddy can obtain certificates again after DNS points to the recovered server.

Keep the repository address, bucket/prefix, storage credentials, recovery password, and installation configuration available outside the server. Follow [installation and disaster recovery](installation.md) if the platform itself is unavailable. Normal app backup and restore uses the browser.

## Implementation

The shared backup schemas live in `packages/contracts/src/backups.ts`. Browser actions enter `/api/backups` or the app backup/restore/schedule endpoints, queue durable jobs in `packages/core/src/backups.ts`, and run in `apps/worker/src/backups.ts`. `backup-runtime.ts` creates constrained, labeled restic helper containers with only the relevant named volumes. Helpers receive no Docker socket or platform data mount. Platform checkpoint files are copied into a helper privately; the web service never receives runtime access.

Credentials are passed as container environment values, not shell commands or command-line arguments. Backup helpers therefore remain accessible to the administrative Docker worker/host, just like the worker’s other privileged operations. Restic command failures and literal configured secrets are redacted before saving progress. Completed/failed helpers are removed; stale leases cannot publish results.

The database `volume_set` field identifies storage activated by a restore. Ordinary lifecycle operations continue using that storage, including subsequent updates and backups. Data-retaining removal does not delete any volume set. Permanent cleanup of retained sets remains separate work.
