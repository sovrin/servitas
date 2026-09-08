# Personal cloud — draft implementation plan

Status: milestone 1 is complete locally. Milestone 2 is implemented as a local preview, with browser installation, routes, logs, persistent storage, and basic lifecycle actions. Full milestone acceptance still requires public HTTPS and host-reboot validation. The TypeScript example now deploys through the browser from an isolated HTTPS Git repository. Settings editing, updates, and JSON/YAML imports are implemented and locally validated. Git configuration discovery now uses durable worker jobs and reviewable imports. Milestone 4 backup/restore workflows and installation/recovery tooling are implemented and locally validated, including platform and app recovery into fresh Docker storage. Milestone 5 now adds a locally validated starter catalog and real-app browser journeys. Fresh Linux VM installation, public HTTPS, and full host reboot acceptance remain outstanding.

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
| Container runtime         | Host Docker Engine, accessed only by the worker | Build images and run hosted app containers                                      |
| Ingress                   | Caddy                                           | HTTPS, HTTP/WebSocket proxying, authentication checks                           |
| Supervision               | Docker Compose and restart policies             | Package and restart platform services; host supervises Docker                   |
| Repository                | pnpm workspace                                  | Share validated contracts between web and worker                                |

Nuxt already provides TypeScript API routes through Nitro, so a separate public API framework is unnecessary initially. [Nuxt documentation](https://nuxt.com/docs/4.x/directory-structure/server).

The web API records durable jobs; the worker claims jobs with leases, serializes changes per app, and reconciles interrupted operations on startup. Deployments must survive browser disconnection and web-process restart. SQLite is platform metadata storage; apps own their databases and files separately.

Only the worker has access to the Docker socket. The web service and future hosted apps must not receive it. Caddy administration uses a Unix socket inside the Caddy container. The worker writes and reloads generated configuration through Docker; no TCP administration endpoint is exposed.

Caddy forwards management traffic to Nuxt. It reaches hosted apps over app-specific container networks without exposing their ports directly. Use explicit app hostnames with certificates obtained automatically; a wildcard DNS record does not require a wildcard certificate. Route updates must be validated and preserve the last working configuration. [Caddy HTTPS](https://caddyserver.com/docs/automatic-https), [authentication integration](https://caddyserver.com/docs/caddyfile/directives/forward_auth).

## Docker installation

The implementation uses a Compose stack containing `web`, `worker`, and `caddy`. Web and worker use separate production image targets from one Dockerfile. The worker creates hosted apps dynamically as sibling containers on the host Docker Engine. Compose manages the platform; the worker manages hosted apps. [Docker Compose documentation](https://docs.docker.com/compose/).

After installing Docker and configuring the environment, run `docker compose up -d --build`. Local HTTP access uses localhost:8080; a public HTTPS domain can be configured separately. Platform SQLite state uses a shared local volume and Caddy certificate state uses its own persistent volume. App data uses separate named volumes. Container replacement must preserve those volumes. Backups must include their contents and the recovery configuration, not just container images. See [README.md](README.md) for runnable instructions.

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

Use a versioned, declarative deployment specification, validated at runtime and supported by JSON Schema. Include source/build information, port, health check, resource limits, named volumes, and required environment-variable names. The installation wizard must let the owner enter and change these settings in the browser. A `servitas.json` or `servitas.yaml` file can be imported to supply defaults; creating or editing it must not be required for app management. Persist dashboard overrides separately with clear precedence over repository defaults, and preview effective configuration before deployment. Store secret values outside Git. Do not execute TypeScript configuration supplied by apps.

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

Implemented: image pulls, public HTTPS Git checkout at a recorded commit, Dockerfile builds, encrypted environment settings, labeled storage/networks/containers, resource limits, initial HTTP health checks, Caddy routes, owner-only access handoff, app install/detail screens, bounded build/runtime logs, and serialized start/stop/retry/remove operations. Removal retains storage and reserves the app name; removed apps can now be restored from the backups implemented in milestone 4.

The local dashboard development command retains hot reload and platform checks. Hosted-app flows run in Compose so the worker can reach app networks. The local preview uses HTTP app subdomains; public HTTPS remains a separate acceptance check.

Validated locally: TypeScript checks and 11 unit/integration tests; production-build owner browser checks; desktop/mobile app-page inspection; and a real Docker/Caddy browser journey covering private image installation, a public Git build, credential filtering, stop/start, service replacement, retained file contents after removal, and failed health checks. Killing the worker during deployment produced a second lease attempt that reused the existing container and reported the health failure truthfully. The isolated test resources were removed afterward. The later repository-discovery check also deploys the TypeScript example from Git. Public-domain HTTPS and a full host reboot remain unverified; this milestone is not yet accepted for production use.

Acceptance: use only the browser to configure and deploy a small TypeScript demo from Git, open its HTTPS URL, and reconnect to logs. Separately restart the server and verify the app and its data recover. An anonymous visitor cannot open a private app.

### 3. Reliable lifecycle and access

Add update/redeploy, retained previous images, failed-job recovery, per-app operation locking, stop/start/delete, secrets management, and explicit publication. Bound build time, log retention, and concurrent builds. Reject arbitrary host mounts, privileged containers, and runtime-socket exposure.

Implemented: shared install/update form, JSON/YAML configuration import, environment keep/replace/remove, effective-settings review, restart, separately persisted candidate revisions, previous image/settings recovery, generation checks for stale forms, and maintenance acknowledgement for apps with volumes. Candidate failure after stateful code may have run requires explicit data-compatibility confirmation before previous-version recovery. Repository-file discovery reads public HTTPS Git repositories in durable jobs; imports pin the form to the inspected commit and support explicit subdirectory paths. App data restore and encrypted backup workflows are implemented in milestone 4.

Validated locally: 17 unit/integration tests and TypeScript checks (including the example app), a production-build owner browser journey, desktop/mobile inspection of imported settings and lifecycle controls, and the real Docker/Caddy workflow. The latter verifies JSON/YAML imports, secret replacement/removal, resource and access changes, restart, retained data through stateful failure/recovery, continued service during stateless update failure, and candidate reuse after killing the worker mid-update. Both v1 and v2 database upgrades preserve existing records; the local preview retained its owner account. Formatting and production builds pass. Snapshot data restore is implemented in milestone 4; custom application export hooks, public-domain HTTPS, and full host reboot validation remain outstanding.

Repository discovery validation: 21 unit/integration checks cover input validation, real Git object reads, ambiguous/missing/oversized files, symlinks, source consistency, lease fencing, saved-result recovery, and v3 database migration with candidate revisions and encrypted secrets intact. Production browser checks cover protected endpoints and failed-read recovery after refresh. Docker/browser checks cover queued-read persistence, JSON/YAML discovery, explicit subdirectory paths, operation-history return links, pinned-commit TypeScript deployment, and desktop/mobile layouts. Production builds and formatting pass.

For stateless apps, switch traffic only after the candidate is healthy. For stateful apps, permit a controlled maintenance window so incompatible versions do not write to the same volume simultaneously. Image rollback does not reverse database migrations; require a compatible migration or a restore path.

Acceptance: start, stop, restart, configure, update, retry, and remove apps through the browser without host commands. A failed stateless update preserves the previous working version; interrupting the worker does not create duplicate deployments; stateful-update failure has a tested recovery procedure; access changes take effect correctly.

### 4. Backups and installation

Expand the Compose installation with prerequisite/DNS checks, platform upgrade/recovery instructions, and disk-space checks for a supported Linux distribution. Implement encrypted off-host backups of platform state and app volumes. Stop apps or use app-specific export hooks to obtain consistent backups. Keep the recovery key available outside the failed server.

Implemented: browser S3-compatible destinations and credential updates, encrypted restic snapshots, daily schedules with maintenance acknowledgement, app restore with typed/generation-bound confirmation, separately restored and verified volumes, retained original data, and removed-app restoration from backups. App backups also save an encrypted platform metadata/key checkpoint. Offline recovery revokes sessions, cancels interrupted jobs, pauses schedules, and prevents apps from starting without restored data. Read-only installation checks cover the Linux engine, memory, platform storage, and DNS. [Operational details](docs/backups.md), [installation and recovery](docs/installation.md).

Validated locally: TypeScript checks, 26 tests, formatting, production builds, owner/authentication browser checks, and desktop/mobile backup workflows. Real Docker with isolated S3-compatible storage verifies encrypted backup/restore, incomplete-snapshot exclusion, worker interruption during both transfer directions, wrong-password isolation and browser credential repair, typed restore confirmation, retained original data, schedule configuration, and installation preflight checks. Disaster recovery into fresh platform/app storage preserves the owner and app records, pauses schedules, and rebuilds the saved Git revision. The complete Docker/Caddy lifecycle regression also passes, including stateful recovery, stateless failure isolation, data retention, and interrupted deployment/update recovery. The local preview upgraded from database v4 to v5 with its owner and encryption key preserved.

Backups use graceful application shutdown; custom database/export hooks and automated retention are not implemented. Images are pulled by saved registry digest or rebuilt from the recorded Git commit on a replacement host. Checkpoints include platform metadata/key and origin settings; certificates can be reissued. Fresh Linux VM installation, public HTTPS, and full host reboot testing remain acceptance work beyond local Docker validation.

Acceptance: configure backups and back up/restore a stateful example through the browser, verifying its records. Separately install on a fresh Linux VM and restore the platform plus app data to prove disaster recovery. Manual platform bootstrap is allowed; normal app backup and restore require no terminal.

### 5. Personal-use beta

Implemented: a small browser catalog for Memos, Uptime Kuma, and IT Tools, editable private-by-default configurations, downloadable `servitas.json` files, app-specific setup/storage guidance, and runtime capacity/version output in platform checks. Platform and catalog images are pinned by digest. The catalog uses the existing schemas, form, API, jobs, and runtime operations. [Beta behavior and validation](docs/beta.md). Validated locally: all three catalog apps install and open privately; native accounts and Memos notes/Uptime Kuma monitors work through the browser. Each app passes stop/start, runtime-log access, configuration redeployment, backup/restore, removal, and removed-app recovery. Stateful restores recover earlier records and exclude records written after the snapshot. Template download/import and editable defaults pass production browser checks; desktop/mobile layouts have been inspected. TypeScript, 26 tests, formatting, and production builds pass. The tested platform images run Node 24.20.0 and Caddy 2.11.4. The full Docker/Caddy lifecycle regression also passes, including interrupted deployments/updates and failure recovery. The updated local preview preserves the owner account and encryption key. Arbitrary upstream app-version upgrades and fresh Linux/public HTTPS/host-reboot acceptance are not claimed.

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
