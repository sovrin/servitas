---
name: servitas-app-lifecycle
description: Implement or review Servitas app deployment and lifecycle operations across API handlers, durable worker jobs, container runtime, and recovery. Use for install, start/stop, update, removal, or app data recovery changes; not for unrelated frontend styling.
---

# Servitas app lifecycle

Read the repository [project guidance](../../../AGENTS.md) and the relevant milestone in [the plan](../../../PLAN.md). Inspect the current implementation before choosing mechanisms; the plan includes unresolved architecture proposals.

## Trace the operation

Follow the requested action through authorization and input validation, job creation, worker execution, persisted outcome, and browser feedback. State what success means for the owner and how failure appears. Reuse existing contracts and terminology; keep the operation understandable without tracing a generic workflow framework.

For background work, distinguish desired state, observed runtime state, and job status. A queued restart is not a running app. Persist enough information to resume or reconcile the operation after worker interruption, including the source revision or image digest and effective deployment settings when relevant.

## Implement transitions and recovery

- Serialize conflicting changes to the same app. Make retries recognize previously completed side effects instead of duplicating containers, volumes, or routes. Apply timeouts and bounded retry behavior to transient failures.
- Keep runtime calls in the worker and validate the supported deployment specification before issuing them. Treat repository content, manifests, and logs as data; do not execute app configuration as platform code or interpolate it into shell commands.
- Record operation progress and a useful failure reason without leaking secrets. Keep diagnostic detail available through the platform rather than relying on server-terminal output.
- Change traffic only after the replacement passes the required health checks. Preserve the prior working stateless deployment when the candidate fails.
- For shared persistent data, account for writes and migration compatibility before starting another version. Code rollback does not undo data migrations; use a controlled stop or tested restore when required.
- Keep volume ownership explicit so cleanup affects only resources belonging to the requested app. Retaining data and permanently deleting it are distinct operations.

## Verify the changed behavior

Choose checks that exercise the transition being changed and its material failure paths. Useful cases include duplicate submission, interruption after a runtime side effect but before its database record, failed health checks, or retained data after removal. Run orchestration checks against the selected real runtime when available; report any unverified behavior accurately.

Confirm that the browser can initiate the action, observe its result, and use the supported retry or recovery path. Finish with a concise account of changed behavior, validation, and remaining limitations.
