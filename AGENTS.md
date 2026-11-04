# AGENTS.md

These instructions apply to work in Plato Explorer. Start with the [project handoff](docs/handoff.md) for decisions and the [README](README.md) for commands. The production target is the public Cloudflare Pages project `plato-network`. Its release procedure is in [public deployment](docs/public-deployment.md).

## Hosting and source publication — apply across projects

- Never use the Sites feature. Create new projects as local Git repositories.
- Deploy only when the user explicitly requests deployment and specifies or agrees to the destination.
- For Plato Explorer, publish source to GitHub. Keep downloaded SEP materials, generated corpus files, article screenshots, build reports, browser snapshots and deployment credentials out of Git and releases. Show the app and sidebar in README screenshots. README screenshots may show a brief, readable excerpt to illustrate a feature. Credit the entry and its author beside the screenshots. See the [copyright notice](COPYRIGHT.md).

Keep the README focused on the explorer, screenshots, local setup and copyright. Keep handoff and release notes in `docs/`. Omit links to the deployed app from the repository.

## Interface styling preferences — apply across projects

- Never use a green colour scheme for apps. Use Plato Explorer as the default style reference, with cool grey backgrounds, white panels, dark text and restrained slate accents.

## Interface copy preferences — apply across projects

- Use concise, functional labels. Include explanatory text only when it helps someone take an action, understand the data, or understand a real limitation. Preserve user-supplied copy unless asked to change it.
- Do not add slogans, taglines, marketing filler, motivational or poetic copy, cute empty-state messages, or decorative headings unless explicitly requested. Examples to avoid include “A clearer view of the places we call home”, “Australia through data”, and “Make the map yours”.
- Apply this preference to new interfaces and revisions in every chat. Pass it to delegated agents.

## Before writing code

1. Read the project guidelines, README, relevant docs and any applicable decision records.
2. Find the closest working example. Follow its structure, naming and surrounding conventions, including when other parts of the project use a different pattern.
3. Search for existing utilities, types, components and libraries. Extend them when appropriate instead of creating a parallel implementation.

## Type safety and boundaries

- No type assertions, non-null assertions, `@ts-ignore`, `@ts-expect-error` or `// eslint-disable`. Fix the underlying logic or type and handle null explicitly.
- Keep types precise. Validate external data at the boundary using existing validators, Zod or an equivalent. Pass validated data into business logic.
- Keep route handlers thin. Validate, check access when required, call the business logic, and return the response.

## Workflow and scope

- Reproduce a bug before fixing it. If reproduction fails, report that finding instead of guessing.
- Make and verify one small change at a time. If an attempt fails, stop, recover a known working state for that change and reintroduce it incrementally.
- Run relevant checks during development and finish with passing tests. Review every changed line for edge cases, naming, complexity and debug code. Check related callers and docs for collateral impact.
- Keep unrelated refactors out of the change. Flag them separately. Remove debug output, `console.log` and commented-out code.
- Run the project's automatic formatter as the final editing step when configured.
- **Commit and push completed changes after the relevant checks without asking for confirmation, unless explicitly told not to push.** Apply this rule in a Git checkout with a configured destination. This workspace currently publishes the app by Pages Direct Upload. The NFS home launcher is a separate Git checkout.

## Subagents

- Automatically delegate independent, well-scoped units of work. Use the default coding model, not Astra, unless explicitly requested. Choose reasoning effort to suit the task.
- Assign clear file ownership, constraints and verification requirements. Share these instructions with each agent. Keep tightly coupled work with the main agent and avoid overlapping edits.
- Agents should communicate dependencies and overlap. The main agent reviews changes, integrates results and verifies the complete outcome.
