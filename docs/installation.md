# Installation, upgrades, and disaster recovery

Servitas currently targets a single Linux Docker engine. Docker Desktop provides local development checks; installation on a fresh Linux VM, public certificate issuance, and a complete host reboot still need separate acceptance testing. A dedicated Linux server with Docker Engine and the Compose plugin is the intended first deployment. No second runtime or multi-server installation is supported.

## Installation checks

Follow the environment and Compose setup in [README.md](../README.md). On a public server, configure the platform domain, app wildcard domain, matching origins, and bindings for TCP ports 80 and 443. DNS must point the platform hostname and every app hostname to Caddy. The initial owner setup requires the installation key from `.env`.

Before starting the services, run the included checks using the built worker image:

```sh
docker compose build
docker compose run --rm --no-deps -l dev.servitas.role=preflight worker node dist/preflight.js
```

These read-only checks inspect the Linux engine, available engine memory, free space on the platform data filesystem, and resolution of the configured platform/app names. Localhost origins explicitly skip public DNS validation. Passing these checks does not prove public reachability, certificate issuance, adequate capacity for every app, or host-reboot recovery.

Then start the platform with the README’s Compose command. Complete owner setup and use **Run platform check** in the browser. Configure a real backup destination, save the recovery password outside the host, and test restoring a representative app before relying on the server.

## Platform updates

Use **Back up platform** and back up important apps before updating. Record the checkpoint’s full snapshot ID from its operation details. Keep the prior checkout/image and the off-server repository credentials available.

Update the checkout, retain `.env` and the Compose project name, then use the README’s Compose update command. SQLite migrations run automatically. Downgrading across a database migration requires restoring the matching earlier platform checkpoint with the matching code version; replacing an image alone does not undo a migration. App data migrations require compatible app code or an app data restore.

## Recover when the platform is unavailable

This is manual disaster recovery, an exception to browser-only app management. Restore into a fresh installation or an explicitly chosen replacement platform data volume. The restore overwrites files in that volume. Keep the old disk/volumes intact until recovery is verified.

1. Install Docker and Compose on the replacement host. Obtain the compatible Servitas checkout, restore `.env` (or recreate its domain/origin settings), and choose the Compose project name below.
2. Supply credentials from your external password manager. The commands below assume Bash; `read -s` keeps secret values out of terminal output and command history.

```bash
export RECOVERY_PROJECT=servitas
export RESTIC_REPOSITORY='s3:https://s3.example.com/your-bucket/servitas'
export AWS_DEFAULT_REGION=us-east-1
read -r -p 'S3 access key: ' AWS_ACCESS_KEY_ID
read -r -s -p 'S3 secret key: ' AWS_SECRET_ACCESS_KEY
printf '\n'
read -r -s -p 'Recovery password: ' RESTIC_PASSWORD
printf '\n'
export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY RESTIC_PASSWORD
```

3. Build/create the replacement services and data volume without starting them. If reusing an installation, stop its web and worker first. List platform checkpoints and choose a full snapshot ID.

```bash
docker compose -p "$RECOVERY_PROJECT" stop web worker
docker compose -p "$RECOVERY_PROJECT" create --build web worker caddy
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  restic/restic:0.19.1 snapshots --tag servitas-platform --json
read -r -p 'Full platform snapshot ID: ' RESTIC_SNAPSHOT
```

4. Restore the checkpoint and verify its contents. The default Compose data-volume name is used here; adapt it if your installation overrides that volume.

```bash
docker run --rm \
  -e RESTIC_REPOSITORY -e RESTIC_PASSWORD \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_DEFAULT_REGION \
  -v "${RECOVERY_PROJECT}_platform-data:/restore" \
  restic/restic:0.19.1 restore "${RESTIC_SNAPSHOT}:/platform" --target /restore --verify
docker compose -p "$RECOVERY_PROJECT" run --rm --no-deps worker \
  node dist/recover-platform.js --confirm-offline-recovery
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY RESTIC_PASSWORD
```

The recovery command requires both the restored database and its original encryption key. It preserves the owner and encrypted settings, revokes sessions, cancels unfinished jobs, disables schedules, and marks apps removed from service. This prevents empty host volumes from being mistaken for recovered app data.

5. Point DNS to the replacement host, start the platform, and sign in with the recovered owner account. Caddy recreates routes/certificates. In **Backups**, choose **Check and load backups**, then restore each app. This downloads and verifies fresh app volumes and checks each restored app before serving it. Confirm records and access settings, then re-enable schedules.

If the checkpoint predates the most recent app backup, repository discovery can load that snapshot. If the platform checkpoint is unavailable but app snapshots survive, bootstrap a new owner, configure the existing destination with its original recovery password, load the backups, and restore apps from the browser.

No backup can recover missing data without its repository and recovery password. Keep storage-provider credentials and the password independent of the server being backed up.
