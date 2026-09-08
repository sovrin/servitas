# App configuration files

Commit `servitas.json` or `servitas.yaml` alongside an app. In **Install app** or **Update app**, choose **Import configuration** and select the file. The settings populate the form and remain editable. Importing does not start a deployment; review the settings and submit the form afterward.

For a Git app, enter its public HTTPS repository URL and branch/tag/commit, then choose **Read repository configuration**. Leave the configuration path blank to discover `servitas.json`, `servitas.yaml`, or `servitas.yml` in the repository root. If several exist, enter the exact path of the one to use. A path such as `examples/hello-cloud/servitas.yaml` also supports apps in subdirectories.

The worker fetches the revision and saves the result as an operation. Refreshing the form preserves the operation link; the platform’s operation history also links back to the configuration. Choose **Apply configuration** to fill the form. Reading alone does not overwrite edits or install an app. Failed reads keep your settings and offer **Edit repository details** so you can correct the source or path and read again.

Repository imports select the exact commit that supplied the file. This keeps the reviewed defaults and deployed code together even if a branch moves. You can change the revision afterward; read the configuration again if you want defaults from that revision. Files should normally omit `source`; if present, it must reference the selected Git URL and may supply a Dockerfile path. Its revision is replaced by the fetched commit. Switching to an image or another repository through a repository file is rejected; local file imports still support either source type.

JSON and YAML use the same versioned format:

```yaml
version: 1
name: my-notes
source:
  type: git
  url: https://github.com/you/my-notes.git
  revision: main
  dockerfile: Dockerfile
port: 3000
healthCheck: /health
access: private
resources:
  memoryMb: 256
  cpu: 1
volumes:
  - name: data
    mountPath: /data
requiredEnv:
  - APP_SECRET
```

`version`, `name`, and `port` are required. `source` can be omitted when a repository or image is already selected in the form. An image source uses `type: image` and `image: registry/name:tag`. Git sources require a public HTTPS URL and a branch, tag, or commit; their Dockerfile path defaults to `Dockerfile` and the build context is the repository root.

The other defaults are private access, `/` for health checks, 256 MB memory, one CPU core, no volumes, and no required environment variables. Names use lowercase letters, numbers, and hyphens and must begin with a letter. Editing an existing app cannot change its name.

`requiredEnv` declares variable names only. Enter values in the browser; configuration files cannot contain an `environment` section or secret values. Existing saved values remain in place unless you replace them or explicitly select them for removal. A required variable must have a saved or supplied value before deployment can be accepted.

Imports replace the displayed manifest settings, using defaults for omitted optional fields. They keep already entered environment values and an already selected source when the file omits `source`. The submitted form is the effective configuration; later edits to the repository file do not automatically change a running app.

Files are limited to 64 KB. Repository files are read directly from Git objects; symlinks and submodules are rejected. Unknown fields, unsupported versions, YAML aliases/custom tags, duplicate YAML keys, and invalid types are rejected. `.yml` is also accepted. An [editor JSON Schema](../schemas/servitas.schema.json) is included; regenerate it with `pnpm schema:generate` after changing the contract. The parser and validation source is `packages/contracts/src/configuration.ts`, composed from the shared manifest schema.

The [Hello Cloud example](../examples/hello-cloud/servitas.yaml) includes equivalent JSON/YAML files and a TypeScript HTTP app with a persisted visit counter. When building it from this repository, select `examples/hello-cloud/Dockerfile` in the source settings. Its Dockerfile expects this repository as the build context.

## Implementation

`POST /api/repositories` validates the shared inspection contract and queues `repository.inspect`; `GET /api/repositories/:id` returns saved progress and the parsed result to the form. The worker fetches with the same Git helper used by builds, records the resolved commit before reading, and fences writes with the job lease. Reclaimed reads reuse the recorded commit. Matching active requests share one job. Configuration reads do not reserve an app name, modify app settings, or run a build.
