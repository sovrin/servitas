---
name: servitas-dashboard
description: Build or review Servitas Nuxt screens and browser workflows for app configuration, lifecycle actions, logs, status, and recovery. Apply the project's minimal, utilitarian UI direction; not a general Nuxt tutorial or infrastructure implementation guide.
---

# Servitas dashboard

Read the repository [project guidance](../../../AGENTS.md) for the visual direction and product contract, and the relevant browser workflow in [the plan](../../../PLAN.md). Inspect existing components and tokens before adding new patterns.

For component work, inspect the installed shadcn-vue primitives and `shadcn-nuxt` configuration. Add only missing components needed by the requested flow using the official Nuxt integration linked in the project guidance. Keep app-specific behavior in feature components and preserve the primitives' accessibility and keyboard behavior when customizing them.

## Make the task understandable

Start with the owner's decision: what they need to know, what they can do, and how they learn the outcome. Use the same names for apps, deployments, versions, and operations throughout the interface. Show implementation details only when they help configure an app or diagnose a problem.

Choose the simplest layout that supports the task. Use rows or tables for comparable apps and deployments, labeled forms for configuration, and a focused detail view for an app. Avoid turning each value into a card. Keep advanced fields available through progressive disclosure; show effective defaults and consequences before submission.

## Connect actions to real outcomes

- Define empty, loading, ready, pending, failed, and completed states as relevant to the workflow. Do not show success when the API has only accepted a job.
- Connect production controls to real API and job state. Development fixtures must remain distinguishable from live results. Prevent conflicting submissions and explain temporarily unavailable actions.
- Restore operation visibility after refresh or reconnect. Use real stages or indeterminate progress when total work is unknown; do not fabricate percentages.
- Place validation next to the affected field and preserve entered values after errors where safe. Do not return stored secrets to prefill forms or expose them in notifications and logs.
- Explain failures in plain language with an available next action. Offer detailed logs when useful. Keep important failures visible beyond a transient toast.
- Make removal's data-retention behavior clear. For permanent deletion or restore-overwrite, identify the affected app and data in the confirmation. Routine reversible actions should remain direct.

## Verify the browser journey

Exercise the changed flow from its entry point through its outcome, including relevant errors. Check keyboard operation, focus behavior, readable statuses without relying on color, and a narrow viewport. Inspect the rendered UI when browser tooling is available; otherwise state the visual-validation limit.

For lifecycle controls, verify feedback against persisted operation state and reconnect behavior. A backend-only implementation or instructions to run terminal commands do not complete a dashboard workflow.
