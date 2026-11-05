# Implementation Part 2 — Bringup, Validation and Release

Prerequisite: [Implementation-Part1.md](Implementation-Part1.md) is complete. This part checks the build against [SystemSpec.md](SystemSpec.md) and gets it ready for public release.

Note: Steps 1 to 5 are complete (Step 5 except tagging and publishing, which need a git history and a registry). Paths below predate the versioned layout of [Implementation-Part3.md](Implementation-Part3.md): templates now live in `templates/v<N>/`, the engine source is in `engine/` (routers in `engine/routers/`, replacing `src/`), and the engine entry point is `dist/engine/index.js`. The spec's definition of done is now section 11 and includes the versioning and delivery items from Part 3, which are checked as that part lands. Terminology follows the current vocabulary: a template is yet to be built, and a document is a template that has been built.

## Step 1 — Bringup

- Fresh-clone test: clone, install, build, run dev and prod from the README alone.
- Fix any undocumented setup steps found.
- Run the prod container with a read-only templates mount and confirm it works.

## Step 2 — Test and CI (F05)

- Contract test that runs over every discovered template: exports present, examples validate against the schema, building succeeds, the document passes integrity checks.
- Determinism test: identical input gives an identical document.
- API tests for 200, 404, 422 and 5xx paths, including path traversal attempts.
- CI pipeline: typecheck, lint, test, build, build the Docker image.
- CI fails if a template breaks its contract.

## Step 3 — Validate against the Definition of Done

Walk through each item in the spec's Definition of Done (section 11) with a recorded result:

- New template directory with no engine changes.
- Auto-discovery in the API and Storybook.
- Schema validation, JSON Schema GET, valid and invalid POSTs.
- CI contract checks.
- Compiled immutable templates in the production container.

## Step 4 — Hardening

- Request body size limit, timeouts, and basic rate limiting guidance.
- Confirm no stack traces or file paths appear in error responses.
- Dependency audit; pin versions and commit the lockfile.
- Check the HTML of built documents in a few real mail clients or a testing service. Record known limitations.
- Run the container as non-root with a minimal base image.

## Step 5 — Public release housekeeping

- Choose and add a LICENSE.
- README: what it is, quick start, how to add a template, API reference, deployment modes.
- A short authoring guide (now `docs/Authoring.md`, replacing the original CONTRIBUTING.md).
- Remove internal-only notes, placeholder data and any secrets from the repo and history.
- Make sure sample templates use neutral, fictional content.
- Version the engine (semver), add a CHANGELOG, and tag v0.1.0.
- Publish the image to a registry, with release notes covering the compiled-bundle versus mounted-bundle decision.

## Step 6 — Post-release follow-ups

- Open issues for the explicitly out-of-scope items in the spec (scheduling, queuing, delivery retries and webhooks, etc.) so expectations are clear. Basic delivery is covered by Part 3.
- Triage first external feedback and fix bringup friction.
