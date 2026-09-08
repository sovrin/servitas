# Servitas

A personal cloud platform with a Nuxt interface and TypeScript worker. Hosted apps are managed through the browser.

This preview supports owner setup/login, installation from public container images or public HTTPS Git repositories, private/public app URLs, persistent storage, environment variables, health checks, logs, start/stop, deployment retry, and removal that retains data. Settings editing, version updates, restart, and previous-version recovery are implemented. Encrypted S3-compatible backups, daily schedules, app data restores, and offline platform recovery are implemented; see [PLAN.md](PLAN.md).

## Develop the dashboard locally

Use Node.js 24+ and pnpm 11.15.1. This mode provides Nuxt hot reload and platform checks. Use the Compose installation below to develop or try hosted-app workflows: the deployment worker must run inside Docker so it can reach app networks.

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000. On first run, the development launcher writes a random installation key to `.data/bootstrap-token`. Use that key in the browser to create your owner account. The launcher starts the web server and worker together, shares their database directory, and discovers your local Docker Unix socket. An unavailable Docker engine is reported as a failed platform check, without preventing login. App installation is disabled in this dashboard-only mode.

Configuration can be supplied in `.env`; see [.env.example](.env.example). Use `SERVITAS_ORIGIN=http://localhost:3000` for the default development URL if setting it explicitly. The origin must match the browser URL for state-changing requests.

## Run with Docker Compose

Copy `.env.example` to `.env` and set `SERVITAS_BOOTSTRAP_TOKEN` to a new random value of at least 32 characters (`openssl rand -hex 32` generates one). Then:

```sh
docker compose up -d --build
```

Open http://localhost:8080 and complete owner setup with that key. Compose runs Nuxt, the worker, and Caddy; only the worker receives the Docker socket. Platform data and certificates use persistent named volumes. Do not use `docker compose down -v` to update the platform, because it deletes those volumes.

For public HTTPS, point a domain to your server and set `SERVITAS_ORIGIN`, `SERVITAS_ADDRESS`, and the HTTP/HTTPS port bindings as shown in `.env.example`. Set `SERVITAS_APPS_ORIGIN` to an app base domain, and point its wildcard DNS record to the server. Caddy obtains certificates for individual app hosts. Local defaults use HTTP and `<app-name>.apps.localhost:8080`; Chromium resolves these names to loopback. Public-domain certificates and a full host reboot have not yet been validated.

The Docker socket gives the worker administrative control over a conventional Docker host. Run this platform on a server you control with trusted owner access. The web container has no socket mount. The platform uses the host Docker daemon. App containers have no published host ports or host bind mounts; Caddy and the worker join each app’s dedicated network. The Caddy control socket is local to its container, and only the worker can reload routes through Docker.

To update the platform from a new checkout, run `docker compose up -d --build`. This may briefly interrupt the dashboard. Replacing the containers retains platform data. Keep the same Compose project name: it identifies ownership of hosted containers and volumes. Retain the complete platform data volume, including `encryption-key`; the database alone cannot recover encrypted environment values.

## Install and manage an app

In the dashboard, choose **Install app**, enter an image reference or public HTTPS Git URL, select the internal HTTP port, and choose access. Private is the default. Advanced settings provide environment variables, named volumes, health-check path, and memory/CPU limits. The app must listen on all container interfaces, not just its loopback interface.

Git installations use a Dockerfile path relative to the repository root, with the root as the build context. The worker records the fetched commit before building. Retries reuse that commit and any completed image/container work. Private repositories, registry credentials, build secrets, and Compose app definitions are not supported yet. Choose **Read repository configuration** to discover `servitas.json` or `servitas.yaml` in Git, or import a local file. Apply and review its settings before deploying; see [the configuration format](docs/app-configuration.md). Builds/pulls are limited to five minutes; the initial HTTP health check has a 60-second deadline.

**Update app** edits the source, port, health check, access, resource limits, environment variables, and storage. Review the effective settings before deploying. Existing secret values are never prefilled; leave them saved, replace them with new values, or explicitly remove their names. Stale edit forms are rejected if another update has already changed the app.

Stateless updates keep the active version serving until the replacement passes its health check. Apps with volumes require an acknowledged maintenance window: the previous container stops before the replacement can mount the data. A failed replacement retains the previous image and settings. If stateful replacement code may have run, **Recover previous version** requires confirmation that the older code can use the current data. Code recovery does not reverse migrations or restore data. **Retry update** repeats the failed target using its saved settings and any already resolved commit/image.

The app page shows persisted operation progress and recent runtime output. **Open app** signs you into a private app using a short-lived, single-use handoff; dashboard and gateway cookies are filtered before requests reach the app. Signing out invalidates app sessions associated with that dashboard session. Public apps bypass the Servitas gate.

**Stop app** withdraws traffic before stopping the container; **Start app** checks health before restoring traffic. **Remove app** deletes the container and route while retaining named storage and operation history. Retained app names remain reserved. Removed apps can be restored from a saved backup. Direct reattachment of retained volumes and permanent deletion are not available in this preview; use Stop for apps you intend to use again.

Environment values are encrypted in the database and never returned to the browser after saving. Runtime logs retain recent output, with literal configured values redacted; applications must still avoid logging secrets in encoded or transformed forms. Installing and running source code is intended for owner-selected, trusted workloads.

## App templates

Use **Browse templates** for Memos, Uptime Kuma, and IT Tools. Templates prefill the ordinary install form with private access, pinned images, and persistent storage where needed. You can also download their `servitas.json` configurations. Read the [beta app setup and validation guide](docs/beta.md).

## Backups and recovery

Open **Backups** to add an S3-compatible destination and save its recovery password outside the server. Select an app, acknowledge its maintenance window, and back it up manually or daily. Restore a selected snapshot through the browser with typed confirmation. Restores use separate volumes and preserve the current volumes until the restored app is checked. Removed apps can be restored from saved backups.

Every app backup also saves a platform recovery checkpoint. Use **Back up platform** separately before platform maintenance. Read [backup behavior and limits](docs/backups.md) and [installation, preflight checks, and disaster recovery](docs/installation.md). Public HTTPS and a complete host reboot remain separate acceptance checks.

## Checks

```sh
pnpm check
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:compose
pnpm test:backups
pnpm test:beta
```

Browser tests use isolated temporary data, the production builds, and port 3100. Set `SERVITAS_REQUIRE_DOCKER=1` to require a successful connection to the real Docker engine. Without that flag, the browser journey also accepts a correctly reported unavailable runtime. Unit checks separately exercise both runtime success and connection failure.

The Compose check builds the real images and exercises browser installation, private access, cookie filtering, HTTPS Git configuration discovery, TypeScript Git builds, stop/start, service replacement, failed health checks, JSON/YAML imports, settings/secret/access updates, previous-version recovery, and data-preserving removal. It uses isolated platform data and removes only resources belonging to that test instance. It uses an isolated HTTPS Git fixture with a test certificate trusted only by its worker. It requires Docker, Chromium, Git, OpenSSL, and network access to container/package registries.

`pnpm test:backups` uses isolated MinIO storage and fresh Compose projects to exercise browser backup/restore, daily scheduling, worker interruption, credential recovery, and platform/app disaster recovery. It deletes only its own fixtures and never uses a configured real backup account.

`pnpm test:beta` uses the same isolated platform/S3 setup to exercise the catalog apps through native browser setup, lifecycle actions, backups, data restore, and recovery after removal.

## Owner recovery

This is platform maintenance and requires host access. Stop the web server before resetting ownership. The operation removes the owner and invalidates every session; it preserves job history and app data.

For a local checkout, run `pnpm owner:reset -- --confirm` with the same `SERVITAS_DATA_DIR` as the platform (the default is `.data`). Configure a new `SERVITAS_BOOTSTRAP_TOKEN`, restart the web server, and complete browser setup again.

For Compose, stop the web service, then reset only the ownership tables in its existing data volume:

```sh
docker compose stop web
docker compose run --rm --no-deps web node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/data/servitas.sqlite'); db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM owner; DELETE FROM rate_limits; COMMIT;'); db.close();"
```

Set a fresh installation key in `.env`, then run `docker compose up -d web` and complete setup. Keep the new key private until setup is complete.

## Code map

| Location                 | Responsibility                                                |
| ------------------------ | ------------------------------------------------------------- |
| `apps/web/app`           | Nuxt pages, shadcn-vue components, browser feedback           |
| `apps/web/server`        | Authentication, request validation, job submission and reads  |
| `apps/worker/src`        | Job execution and Docker connection                           |
| `packages/contracts/src` | Validated inputs and shared public types                      |
| `packages/core/src`      | SQLite migrations, sessions, encrypted settings, durable jobs |

The job flow is explicit: API inserts a job → worker claims a lease → worker records progress → browser reads the persisted result. Expired leases can be reclaimed; stale workers cannot overwrite newer results. App operations serialize per app and reconcile deterministic, ownership-labeled containers, networks, and volumes. The worker observes runtime state and refreshes routes/logs after service replacement. The install path is `AppForm.vue` → `POST /api/apps` → `createApp` → `runAppJob` → the app detail page. Updates use `POST /api/apps/:id/updates` → `queueUpdate` → `runUpdateJob`; a durable revision holds candidate settings separately from the active app. See [the update design](docs/app-updates.md).

See [PLAN.md](PLAN.md) for the remaining milestones and [AGENTS.md](AGENTS.md) for development guidance.
