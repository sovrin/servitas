# Personal cloud — draft implementation plan

Status: milestone 1 foundation implemented and locally validated. The first usable slice covers owner access, platform checks, and durable operation history. App deployment and lifecycle management remain subsequent milestones.

Project guidance and two focused development skills are in place. [AGENTS.md](AGENTS.md) is the maintained source for the confirmed low-comprehension-debt engineering approach and minimal, utilitarian, modern UI direction. These are implementation and review criteria throughout the milestones below.

## Product direction

Build a personal app hosting platform: install apps, give them HTTPS URLs, control who can access them, and keep their data on a server you own. All first-party application code will use TypeScript, with Nuxt for the web interface. Infrastructure tools and hosted third-party apps can use other languages.

Confirmed requirement: the platform is the complete management interface for hosted apps. Installing, configuring, starting, stopping, restarting, updating, diagnosing, backing up, restoring, and removing supported apps must be possible through the browser. A workflow that requires the owner to SSH into the server, run Docker commands, or edit server files to manage an app is incomplete.

Manual installation and updates of the cloud platform itself are acceptable, as is host maintenance and disaster recovery when the platform is unavailable. These exceptions do not apply to ordinary hosted-app management. Platform self-updating is not a first-release requirement.

Cloud in a Bottle is the product reference. Its core model combines Git-based container builds, manifest-driven configuration, private-by-default routes, lifecycle management, and persistent storage. This proposal is an independent implementation; compatibility with its manifest is a possible later adapter, not an initial requirement. [Reference](https://github.com/cloud-in-a-bottle/cloud-in-a-bottle), [manifest specification](https://cloudinabottle.org/docs/creating_an_app/manifest_spec.html).

Working assumptions, pending user preferences:

- One owner and one Linux VPS with a domain for the first release.
- Start with your own Git repositories; support prebuilt container images through the same deployment model.
- Owner-selected, trusted workloads. This is not a sandbox for arbitrary users to execute code.
- One HTTP service per app initially; persistent volumes supported from the beginning.
- Development on macOS; deployment integration tests in a Linux VM.

## Proposed architecture

| Component                 | Choice                                          | Responsibility                                                                  |
| ------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------- |
| Dashboard and public API  | Nuxt 4, Vue, TypeScript, Nitro on Node.js       | Setup, owner sessions, app management, logs and deployment status               |
| UI components (confirmed) | shadcn-vue with `shadcn-nuxt`, Tailwind CSS     | Shared controls and theme tokens following the interface direction in AGENTS.md |
| Host worker               | Separate TypeScript process on Node.js          | Builds, container operations, routing changes, backups, recovery                |
| Platform database         | SQLite                                          | Apps, deployments, jobs, sessions, secret metadata, audit events                |
| Container runtime         | Host Docker Engine, accessed only by the worker | Check runtime availability now; build and run apps in milestone 2               |
| Ingress                   | Caddy                                           | HTTPS, HTTP/WebSocket proxying, authentication checks                           |
| Supervision               | Docker Compose and restart policies             | Package and restart platform services; host supervises Docker                   |
| Repository                | pnpm workspace                                  | Share validated contracts between web and worker                                |

Nuxt already provides TypeScript API routes through Nitro, so a separate public API framework is unnecessary initially. [Nuxt documentation](https://nuxt.com/docs/4.x/directory-structure/server).

The web API records durable jobs; the worker claims jobs with leases, serializes changes per app, and reconciles interrupted operations on startup. Deployments must survive browser disconnection and web-process restart. SQLite is platform metadata storage; apps own their databases and files separately.

Only the worker has access to the Docker socket. The web service and future hosted apps must not receive it. The initial Caddy configuration disables its administration API; adding dynamic routing will require an explicitly protected control interface.

Caddy forwards management traffic to Nuxt. In milestone 2 it will reach hosted apps over app-specific container networks without exposing their ports directly. Use explicit app hostnames with certificates obtained automatically; a wildcard DNS record does not require a wildcard certificate. Route updates must be validated and preserve the last working configuration. [Caddy HTTPS](https://caddyserver.com/docs/automatic-https), [authentication integration](https://caddyserver.com/docs/caddyfile/directives/forward_auth).

## Docker installation

The implementation uses a Compose stack containing `web`, `worker`, and `caddy`. Web and worker use separate production image targets from one Dockerfile. In milestone 2, the worker will create hosted apps dynamically as sibling containers on the host Docker Engine. Compose manages the platform; the worker manages hosted apps. [Docker Compose documentation](https://docs.docker.com/compose/).

After installing Docker and configuring the environment, run `docker compose up -d --build`. Local HTTP access uses localhost:8080; a public HTTPS domain can be configured separately. Platform SQLite state uses a shared local volume and Caddy certificate state uses its own persistent volume. Future app data will use separate named volumes. Container replacement must preserve those volumes. Backups must include their contents and the recovery configuration, not just container images. See [README.md](README.md) for runnable instructions.

Only the worker mounts the Docker socket. Access to a conventional rootful Docker daemon effectively grants administrative control over the host; keeping the worker in a container does not restrict that authority. The dashboard and hosted apps must never receive the socket. [Docker security documentation](https://docs.docker.com/engine/security/).

Support Docker initially. Do not build a second runtime adapter or nested engine. When adding builds, send Git build contexts to the daemon as archives; paths inside the worker are not automatically host paths.

## First release scope

Every capability below must have a browser workflow. The worker performs infrastructure operations in the background and returns progress, logs, outcomes, and actionable errors to the dashboard.

- Owner bootstrap and login, with a documented account-recovery procedure.
- Create an app from a Git repository containing a Dockerfile, or from a prebuilt image.
- Configure environment variables, secrets, app port, health check, CPU/memory limits, and volumes.
- Deploy, view build/runtime logs, inspect health, start, stop, restart, update, and remove an app.
- App subdomains with HTTPS and WebSocket support.
- Private-by-default access; explicitly publish an entire app. Per-path sharing can follow later.
- Persistent data preserved across restart, update, and ordinary app removal; data deletion is a separate explicit operation.
- Deployment history, failed-update recovery, and application-aware backup/restore.
- Basic disk, memory, CPU, and service-health visibility.

Use a versioned, declarative deployment specification, validated at runtime and supported by JSON Schema. Include source/build information, port, health check, resource limits, named volumes, and required environment-variable names. The installation wizard must let the owner enter and change these settings in the browser. An optional `servitas.json` in a repository can supply defaults; creating or editing it must not be required for app management. Persist dashboard overrides separately with clear precedence over repository defaults, and preview effective configuration before deployment. Store secret values outside Git. Do not execute TypeScript configuration supplied by apps.

### Required browser workflows

- Add app: enter a Git URL or image reference, configure required settings and secrets, choose access, and deploy. Show validation errors before starting work.
- App overview: show URL, desired and actual state, deployed commit or image digest, resource use, and current operation. Offer start, stop, restart, and remove actions.
- Configuration: edit environment variables, secrets, resource limits, storage, health check, and access settings; show when applying a change requires a restart or redeploy.
- Updates: select a Git revision or image tag/digest, review the target and configuration changes, and trigger the build/pull and deployment. Show progress and the result, with retry and recovery actions. Automatic update discovery can follow later; manual updates in the UI are required initially.
- Diagnostics: read build/runtime logs and health failures directly in the app detail view. Long-running operations continue after navigation or browser disconnection.
- Recovery: configure the backup destination and schedule, run a backup, view its outcome, select a restore point, and restore app data with explicit confirmation of replacement. Offer version rollback when data compatibility allows it.
- Removal: remove an app while retaining its data by default; permanently deleting data requires a separate explicit confirmation.

Suggested screens: initial setup, app overview, add-app wizard, app details (status, deployments, logs, settings, backups), and platform settings. A browser terminal is not a substitute for these management workflows.

Access design must cover dashboard sessions and private app sessions. Use maintained authentication primitives, host-only cookies, CSRF protection, and a short-lived authorization handoff to app hosts rather than exposing the dashboard session across all subdomains. Strip session credentials before proxying to apps. Publishing an app bypasses the platform access gate; any app-native login remains the app's responsibility.

## Delivery milestones

### 1. Foundation and deployment contract

Create the workspace, Nuxt shell with shadcn-vue/`shadcn-nuxt` and shared theme tokens, worker entry point, shared manifest validation, database migrations, and CI checks. Define job states and owner authentication. Validate Docker socket access from the worker and persistence across service restarts before implementing app deployment states in milestone 2. Use Node's built-in SQLite API on Node 24+ and run persistence/recovery checks when upgrading Node.

Acceptance: authenticated dashboard can submit a durable job; worker completes it and reports progress; unauthorized requests fail; invalid manifests are rejected.

Implemented: owner bootstrap/login/logout, hashed server-side sessions, origin checks and login rate limits, schema validation, versioned SQLite initialization, leased jobs, worker heartbeat, a real Docker/storage check, operation history, shadcn-vue screens, and Compose packaging. Icons use `@lucide/vue`.

Validated locally: TypeScript checks, seven unit/integration tests, a production-build browser journey with real Docker access, desktop/mobile visual inspection, and an isolated Compose check that replaces containers and verifies queued-job and session persistence. Public-domain HTTPS and a full host reboot have not been tested. CI is configured but has not run remotely.

### 2. First app online

Implement prebuilt-image deployment first to validate the runtime quickly, then Git checkout at a recorded commit and Dockerfile builds. Add volume provisioning, resource limits, health checks, Caddy routes, deployment logs, and app detail pages.

Acceptance: use only the browser to configure and deploy a small TypeScript demo from Git, open its HTTPS URL, and reconnect to logs. Separately restart the server and verify the app and its data recover. An anonymous visitor cannot open a private app.

### 3. Reliable lifecycle and access

Add update/redeploy, retained previous images, failed-job recovery, per-app operation locking, stop/start/delete, secrets management, and explicit publication. Bound build time, log retention, and concurrent builds. Reject arbitrary host mounts, privileged containers, and runtime-socket exposure.

For stateless apps, switch traffic only after the candidate is healthy. For stateful apps, permit a controlled maintenance window so incompatible versions do not write to the same volume simultaneously. Image rollback does not reverse database migrations; require a compatible migration or a restore path.

Acceptance: start, stop, restart, configure, update, retry, and remove apps through the browser without host commands. A failed stateless update preserves the previous working version; interrupting the worker does not create duplicate deployments; stateful-update failure has a tested recovery procedure; access changes take effect correctly.

### 4. Backups and installation

Expand the Compose installation with prerequisite/DNS checks, platform upgrade/recovery instructions, and disk-space checks for a supported Linux distribution. Implement encrypted off-host backups of platform state and app volumes. Stop apps or use app-specific export hooks to obtain consistent backups. Keep the recovery key available outside the failed server.

Acceptance: configure backups and back up/restore a stateful example through the browser, verifying its records. Separately install on a fresh Linux VM and restore the platform plus app data to prove disaster recovery. Manual platform bootstrap is allowed; normal app backup and restore require no terminal.

### 5. Personal-use beta

Run several real apps, improve setup errors and daily workflows, and add a small curated template collection. Test installation and updates against the exact runtime/framework versions we ship. Pin those versions when implementation begins.

Acceptance: after platform installation, the owner can install, use, update, diagnose, back up, restore, and remove the selected apps entirely through the browser. Needing host commands or server-file edits for any supported app-management workflow is a release blocker.

## Suggested repository layout

```text
apps/web/             Nuxt dashboard and Nitro API
apps/worker/          Deployment jobs and host integration
packages/contracts/  Shared schemas and API types
packages/core/       Deployment rules, state transitions, database access
infra/               Caddy configuration and installation resources
examples/            Stateless and stateful test apps
docs/                Architecture decisions and operator guides
```

## Validation strategy

- Unit checks for manifest boundaries, authorization, and deployment state transitions.
- Linux container integration checks against real Docker and Caddy for platform restart/persistence now, and app deploy/update behavior in later milestones. Full host-reboot validation remains part of deployment acceptance.
- Browser checks for the complete app lifecycle, configuration, update failures and recovery, backups/restores, private/public access, and errors. Run the acceptance journey without SSH, Docker CLI, or server-file edits after platform bootstrap.
- Recovery checks for interrupted builds, failed health checks, full disks, and clean-machine restore.

## Later scope

Multi-service app templates and databases; private Git-provider integrations; deploy-on-push; home-server tunneling; multiple users and sharing; a larger app catalog; custom domains; optional Cloud in a Bottle manifest import. Multi-server scheduling, billing, a marketplace, and arbitrary untrusted workloads are outside the initial release.

## Decisions to settle before implementation

1. Deployment target: a Linux VPS, home server/NAS, or both.
2. First-use priority: your Git apps, existing self-hosted apps, or both equally.
3. Three representative apps: their database, networking, and storage requirements will determine whether one service per app is sufficient.

If existing apps requiring separate databases are the priority, move multi-service support into milestone 2 and revise the first release accordingly.
