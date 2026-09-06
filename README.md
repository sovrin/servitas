# Servitas

A personal cloud platform with a Nuxt interface and TypeScript worker. Hosted apps will be managed entirely in the browser.

The first implementation covers owner setup/login, platform health checks, and persistent background operation history. App installation, app lifecycle controls, routing, and backups are planned next; this foundation does not deploy apps yet.

## Develop locally

Use Node.js 24+ and pnpm 11.15.1. Docker is needed for a successful platform check.

```sh
pnpm install
pnpm dev
```

Open http://localhost:3000. On first run, the development launcher writes a random installation key to `.data/bootstrap-token`. Use that key in the browser to create your owner account. The launcher starts the web server and worker together, shares their database directory, and discovers your local Docker Unix socket. An unavailable Docker engine is reported as a failed platform check, without preventing login.

Configuration can be supplied in `.env`; see [.env.example](.env.example). Use `SERVITAS_ORIGIN=http://localhost:3000` for the default development URL if setting it explicitly. The origin must match the browser URL for state-changing requests.

## Run with Docker Compose

Copy `.env.example` to `.env` and set `SERVITAS_BOOTSTRAP_TOKEN` to a new random value of at least 32 characters (`openssl rand -hex 32` generates one). Then:

```sh
docker compose up -d --build
```

Open http://localhost:8080 and complete owner setup with that key. Compose runs Nuxt, the worker, and Caddy; only the worker receives the Docker socket. Platform data and certificates use persistent named volumes. Do not use `docker compose down -v` to update the platform, because it deletes those volumes.

For public HTTPS, point a domain to your server and set `SERVITAS_ORIGIN`, `SERVITAS_ADDRESS`, and the HTTP/HTTPS port bindings as shown in `.env.example`. Caddy manages the platform certificate. App subdomains and access gateways are not implemented yet.

The Docker socket gives the worker administrative control over a conventional Docker host. Run this platform on a server you control with trusted owner access. The web container has no socket mount. This foundation uses the host Docker daemon; it does not run Docker inside Docker.

To update the platform from a new checkout, run `docker compose up -d --build`. This may briefly interrupt the dashboard. Replacing the containers retains platform data.

## Checks

```sh
pnpm check
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
pnpm test:compose
```

Browser tests use isolated temporary data, the production builds, and port 3100. Set `SERVITAS_REQUIRE_DOCKER=1` to require a successful connection to the real Docker engine. Without that flag, the browser journey also accepts a correctly reported unavailable runtime. Unit checks separately exercise both runtime success and connection failure.

The Compose check builds the real images, runs them in an isolated project, verifies Caddy routing and a Docker check, replaces the services, and verifies persisted sessions and queued operations. It removes only that test project's containers and volumes afterward.

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

| Location                 | Responsibility                                               |
| ------------------------ | ------------------------------------------------------------ |
| `apps/web/app`           | Nuxt pages, shadcn-vue components, browser feedback          |
| `apps/web/server`        | Authentication, request validation, job submission and reads |
| `apps/worker/src`        | Job execution and Docker connection                          |
| `packages/contracts/src` | Validated inputs and shared public types                     |
| `packages/core/src`      | SQLite migration, owner/session storage, durable jobs        |

The job flow is explicit: API inserts a job → worker claims a lease → worker records progress → browser reads the persisted result. Expired leases can be reclaimed; stale workers cannot overwrite newer results. The initial check is read-only and safe to retry. Container mutations will need resource reconciliation before using the same retry mechanism.

See [PLAN.md](PLAN.md) for the remaining milestones and [AGENTS.md](AGENTS.md) for development guidance.
