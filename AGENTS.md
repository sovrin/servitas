# Servitas project guidance

## Product contract

Servitas is a personal cloud platform for managing hosted apps entirely through the browser. Use Nuxt for the frontend and TypeScript for first-party application code.

A supported app workflow is incomplete if the owner must use SSH, Docker commands, or edit server files. Manual platform installation, platform updates, host maintenance, and disaster recovery when the platform is unavailable are acceptable exceptions. This restriction concerns the product experience, not developer tooling.

Read [PLAN.md](PLAN.md) for scope, milestones, and architecture proposals. Distinguish confirmed requirements from working assumptions; do not turn an undecided runtime or deployment target into a permanent convention.

## Keep comprehension debt low

- Make the path from a user action to its API handler, job, runtime operation, and visible result easy to follow. Use consistent domain names across these boundaries.
- Prefer explicit control flow, small cohesive modules, and familiar framework conventions. Introduce abstractions when they simplify a concrete need, not for hypothetical future runtimes or plugins.
- Keep each rule, schema, and state definition in one maintained location. Reference it instead of copying it into several layers or documents. Validate external input at runtime; TypeScript types alone are insufficient.
- Make side effects, persistence, and failure behavior visible in names and interfaces. Separate job acceptance from operation completion.
- Document non-obvious reasons and operational constraints near the relevant code. Record consequential architecture decisions briefly; avoid commentary that restates the implementation.
- Update affected documentation with behavior changes. Add runnable commands only once the tooling exists; do not invent scripts or test results.

## Interface direction

Use shadcn-vue components with the `shadcn-nuxt` integration and Tailwind CSS. Follow the [official Nuxt setup](https://www.shadcn-vue.com/docs/installation/nuxt). Add components as needed, keep shared styling in theme tokens, and compose existing primitives before introducing custom controls or wrapper layers.

Keep the UI minimal, utilitarian, and modern. Prioritize readable typography, compact but comfortable layouts, clear hierarchy, neutral surfaces, restrained color, and consistent controls. Use color to communicate state or action; accompany status colors with text.

Give common tasks direct, labeled controls. Show advanced settings progressively without hiding information needed to make a decision. Avoid decorative dashboards, redundant cards, and motion that does not explain a change. Preserve keyboard access, visible focus, responsive layouts, and accessible contrast.

## Implementation boundaries

- Keep container control in the worker. The browser and hosted apps must not receive runtime sockets or platform secrets.
- Preserve app data across ordinary lifecycle operations. Permanent deletion and restore-overwrite need explicit confirmation in the product UI.
- Keep background operations durable and their progress observable after navigation or reconnection. Report failures truthfully and provide supported recovery actions.
- Verify the behavior and failure paths affected by a change. Use real runtime integration checks for orchestration and browser checks for management workflows where appropriate; do not substitute tests that only mirror code structure.

## Focused skills

Use these repository skills when their workflows apply:

- [servitas-app-lifecycle](.agents/skills/servitas-app-lifecycle/SKILL.md): deployment and lifecycle implementation, including jobs, persistence, and recovery.
- [servitas-dashboard](.agents/skills/servitas-dashboard/SKILL.md): browser management flows, operational feedback, and UI changes.

Keep skills focused on procedures. Shared requirements belong here; delivery scope belongs in the plan. Add further guidance when actual implementation experience justifies it.
