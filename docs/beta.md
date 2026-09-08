# Personal-use beta

Open **Apps → Browse templates** to start with a reviewed configuration. **Configure** opens the normal installation form; it does not deploy immediately. Names, access, resources, storage, and health checks remain editable. Entries use private access and immutable image digests. Download **servitas.json** to keep the same configuration alongside a repository or import it later.

Template definitions and exact image references live in [`packages/contracts/src/templates.ts`](../packages/contracts/src/templates.ts). There is no separate template executor or app-specific privilege system. After installation, **App setup and storage** on the app page keeps the relevant instructions available.

## Starter apps

| App         | First browser setup                                                                  | Data covered by backup                                                        |
| ----------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Memos       | Create the app's administrator account, then write a note.                           | SQLite accounts/notes and local attachments in the configured data volume.    |
| Uptime Kuma | Choose **SQLite**, create its administrator account, and add an HTTP or TCP monitor. | SQLite settings, monitors, and history in the configured data volume.         |
| IT Tools    | Open a utility; no app account is required.                                          | Deployment settings only. Browser preferences and inputs are not server data. |

Servitas authentication protects the entire app. App-native accounts are separate and should be created while access is private. Publishing Uptime Kuma publishes the entire app; per-path status-page sharing and Docker socket monitoring are not supported. The templates require neither an external database nor host-file edits. Uptime Kuma's other database choices are outside this template's tested configuration.

Upstream installation references: [Memos](https://usememos.com/docs/deploy/docker), [Uptime Kuma](https://github.com/louislam/uptime-kuma/wiki), [IT Tools](https://github.com/CorentinTh/it-tools).

## Daily operations

Use the app page to open, stop, start, restart, inspect logs, and update an app. **Update app** shows the current pinned image. Changing a version is an explicit edit; selecting a template again does not silently upgrade an existing installation. Read the upstream release notes and save an app backup before changing versions. An image change can migrate its data; recovering previous code alone does not reverse a migration.

Use **Backups** to save app settings and data, select a restore point, and confirm replacement. Restore uses separate volumes and retains the original data. Removed apps can be restored from the same screen. See [backup behavior and limits](backups.md).

**Run platform check** reports free platform storage, Docker availability, engine CPU/memory capacity, and the worker's Node.js version in its persisted operation details. These are capacity checks, not live utilization graphs. Docker Desktop reports its Linux engine's capacity, rather than the Mac's total resources.

## Validation and release limits

`pnpm test:beta` uses the isolated platform/S3 fixture from `scripts/test-backups.ts` and runs the real-app browser journeys in `scripts/beta-apps.ts`. No production backup account or user installation is used. The suite covers catalog selection, native account setup and records, stop/start, runtime logs, configuration redeployment, backups, replacement restores, and recovery after removal. It checks that records saved before a backup return and records added afterward disappear for the stateful apps. Configuration redeployment uses the pinned app release; this does not establish compatibility with arbitrary upstream version upgrades.

The platform Node image in `Dockerfile`, Caddy in `compose.yaml`, and catalog app images are pinned by multi-architecture digest. Framework/dependency versions remain exact in the package manifests and lockfile. Updating these pins requires rerunning the browser and Docker checks; a pin is not an automatic security update service.

Local browser validation passed for all three catalog apps, including the data checks above and desktop/mobile catalog inspection. The pinned platform images tested here run Node 24.20.0 and Caddy 2.11.4. TypeScript checks, 26 tests, formatting, production builds, the owner/template-import browser journey, and the complete Docker/Caddy lifecycle regression pass.

Local beta validation does not replace installation and recovery on a fresh Linux VM, public HTTPS certificate/access testing, or a full host reboot. Those acceptance checks remain outstanding in [PLAN.md](../PLAN.md). Automated backup retention, custom application export hooks, live resource utilization, and multi-service templates remain outside this beta implementation.
