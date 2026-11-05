# CLAUDE.md

mailjot is a filesystem-driven email rendering service (Node 24, TypeScript, Express, React Email, Zod). Templates are built into documents (a subject, HTML and plaintext); optional transports deliver them. Guiding principle: **adding a template or a transport never requires changing the engine.**

## Terminology

- A **template** is an email that is yet to be built: source with a Zod schema, a React Email component, a subject and examples. It lives in `templates/vN/` and is authored, versioned and compiled.
- A **document** is a template that has been built: the subject, HTML and plaintext produced by rendering a template with an input. The render route returns documents and transports deliver them.
- A **message** is a document plus its envelope; that is what a transport receives.
- "Building" a template means rendering it with an input, not `npm run build` (which compiles code).

Longer references: [README.md](README.md) (usage, API), [docs/Architecture.md](docs/Architecture.md) (how it fits together), [docs/Authoring.md](docs/Authoring.md) (setup, adding templates and versions), [docs/Sending.md](docs/Sending.md) (sender routes and writing a transport), [docs/Testing.md](docs/Testing.md), [docs/Storybook.md](docs/Storybook.md), [templates/v1/ory/pipeline.md](templates/v1/ory/pipeline.md) (designing templates for external systems such as Ory Kratos), [docs/OrySpec.md](docs/OrySpec.md) (Kratos emails and parameters), [docs/spec/SystemSpec.md](docs/spec/SystemSpec.md) (requirements), [docs/spec/Implementation-Part3.md](docs/spec/Implementation-Part3.md) (versioning and transports design), [CHANGELOG.md](CHANGELOG.md).

## Commands

```
npm run typecheck          # tsc over everything, including tests and stories
npm test                   # vitest; includes the contract test over every template and transport
npm run coverage           # same tests, plus a coverage report in coverage/ (terminal table and HTML)
npm run build              # engine + templates + transports into dist/
npm run dev                # API with restart on change (TSX)
npm run storybook          # template preview on :6006
npm start                  # compiled engine against dist/templates and dist/transports (build first)
scripts/sender             # try the sender by hand: -T transport, -t template, -f body file (needs MAILJOT_TRANSPORT_AUTH_TOKEN)
scripts/render             # build a template into a document by hand: -t template, -f body file (no token, nothing sent)
```

Individual compilers: `engine-compiler`, `template-compiler` (compiles the templates), `transport-compiler`. **Always run `npm run typecheck` and `npm test` before finishing a change**; vitest does not typecheck.

## Layout

```
engine/               the engine: discovery, loaders, rendering, sender, auth, logging (logger.ts, requestLog.ts)
engine/routers/v1/   the v1 bundle: everything specific to API v1. One bundle directory per API version.
  router.ts          the router (default export); discovered by the engine
  envelope.ts        the provider-neutral delivery envelope
  sender.ts          the build-and-send pipeline and its flat error shape
  transport.ts       the transport contract: types for plugins, plus the engine's runtime check
                     Everything else in engine/ is version-agnostic.
templates/v1/<group>/<name>/   templates served at /v1 (mounted in production, not in the image)
transports/v1/<Name>/          delivery plugins served at /v1 (mounted in production, not in the image)
test/fixtures/        deliberately broken templates and transports (never built, never in templates/ or transports/)
scripts/               sender and render (curl wrappers for the sender and the render route), with their default bodies sender-data.json and render-data.json
storybook/, .storybook/        preview tooling
```

Compiled layout: `dist/engine/index.js` (entry, routers in `dist/engine/routers/`), `dist/templates/`, `dist/transports/`. In production the engine image holds only the engine and routers; templates and transports are mounted read-only at `/app/templates` and `/app/transports` so their imports (`zod`, `react`) resolve against `/app/node_modules`.

Environment: `PORT`, `TEMPLATES_DIR`, `TRANSPORTS_DIR`, `LOG_LEVEL` (`trace` to `silent`, default `info`), `MAILJOT_TRANSPORT_AUTH_TOKEN` (bearer token for the sender routes, at least 16 chars, otherwise all sender requests get 401), and each transport's own variables (Mailjet: `MAILJET_API_KEY`, `MAILJET_API_SECRET`, optional `MAILJET_API_URL`; Logging: optional `LOGGING_INCLUDE_BODY`; Recording: required `RECORDING_DIR`). Built-in transports: `Mailjet` (delivers), and `Logging`, `Recording` and `BlackHole` (deliver nothing, for development and testing; BlackHole needs no configuration and writes one `info` log line whose message is `Swallowed <n> characters on <n> lines!` for every message).

## How versioning works

One version number, `N`, covers three things that must agree:

- the API prefix `/vN`,
- the content directories `templates/vN/` and `transports/vN/`,
- the version bundle `engine/routers/vN/` (router, envelope, sender, transport contract).

**The router resolves its own version.** The generic engine (`engine/app.ts`) knows nothing about any version's contract. For each `vN` directory it loads `engine/routers/vN/router.ts` and calls it with a `VersionContext`: the version, `templatesDir` (`templates/vN`), `transportsDir` (`transports/vN`) and the environment. The router builds its own template loader, its own transport loader with its own contract (`transportContractV1` in `engine/routers/v1/transport.ts`), and its own sender and envelope, all from the same bundle. So the v1 router loads v1 transports and sends documents built from v1 templates; a v2 router can use a different contract, envelope or sender without touching v1 or the generic loaders.

Each version directory is a **complete set**: there is no fallthrough to an earlier version. A templates version directory with no `engine/routers/vN/router.ts` stops startup. **A released version is frozen**: never change request or response shapes of `v1`; a breaking change is a new version.

## External pipelines

`templates/v1/ory/` holds templates that mailjot does not send itself: they are built once with ALL_CAPS stand-in strings through the Recording transport (`maketmpl`) and converted to Ory Kratos Go templates (`gotmpl`). Their inputs are strings so the `{{ }}` integrity check stays in force, and `maketmpl` and `gotmpl` are scripts, not templates. A new Ory template needs a payload `<key>.json`, a `KEYS` entry in `maketmpl` and a stand-in in `gotmpl`'s `VALUES`; see [templates/v1/ory/pipeline.md](templates/v1/ory/pipeline.md).

## Adding things

### Add a template

1. Create `templates/v<N>/<group>/<name>/` with `index.tsx`, `schema.ts` and `<name>.stories.tsx`. Copy `templates/v1/accounts/welcome` (minimal) or `templates/v1/billing/receipt` (table, computed total, dynamic subject).
2. `index.tsx` exports `schema`, `metadata` (`{ id, version, description }`, `id` equals the path within the version), `subject` (string or function), `default` (React Email component) and `examples` (at least one, each valid against the schema).
3. Rules: `z.strictObject`; derive types with `z.infer`; **no `.default()` or `.transform()`** (the contract has one type for input and output); build text with template strings; add `data-text-format="dataTable"` to data tables so the plaintext aligns; the built document must not contain `undefined`, `NaN`, `[object Object]` or `{{ }}`; neutral fictional example data; browser-safe code only (templates are bundled into Storybook).
4. The story file is `templateStories(doc)` boilerplate; see [docs/Storybook.md](docs/Storybook.md). Keep it inside the template's directory.
5. Nothing to register. The API, Storybook and the contract test (`engine/contract.test.ts`) pick it up. Add a `*.test.ts` next to it only for template-specific logic.

### Add a transport

1. Create `transports/v<N>/<Name>/transport.tsx` and `transport.test.tsx`. Copy `transports/v1/Mailjet/`.
2. Exports: `metadata` (`{ id, description }`, `id` equals the directory name), `config` (Zod over environment variables, `UPPER_SNAKE_CASE`), optional `options` (strict Zod, **must accept `{}`**), and a default `send(message)` that returns `{ ok: true, messageId?, response }` or `{ ok: false, reason: "rejected" | "unreachable", message, response? }`.
3. Rules: `import type` from `engine/routers/vN/transport.ts` only, never engine code at runtime (transports are compiled and mounted separately); failures are returned, not thrown; never put credentials or raw network errors in results; log through `message.logger`, never `console`, and log events, not content (no `subject`, `html`, `text`, `envelope`, option values, credentials or provider error text); time-box the request; keep provider specifics inside the directory, and do not change the shared envelope for one provider (use `options`); tests mock `fetch`, no network.
4. Nothing to register. Names match case-insensitively. A transport with missing config is listed unavailable and returns 503. Sender routes work for a version only while `transports/vN/` has at least one transport (checked on every request, so adding one needs no restart; with none they answer 404). Editing a transport or template that has already loaded needs a restart, because of Node's module cache.
5. Test-only transports go in `test/fixtures/transports/`, never in `transports/`.

### Add a router (a new API version)

1. Copy `templates/v<N>/` to `templates/v<N+1>/` (and `transports/v<N>/` to `transports/v<N+1>/` if the new version delivers mail). Update each template's `metadata.version` to `<N+1>.0.0` (the major must equal the directory's). Apply the breaking changes only in the new copy.
2. Copy the bundle `engine/routers/v<N>/` to `engine/routers/v<N+1>/` (router, envelope, sender, transport contract). In the new `router.ts` rename the factory (`createRouter` stays the default export, which may be async) and import the bundle's own modules; keep the transport plugin types and the engine's runtime check (`transportContractV<N+1>`) together in the new `transport.ts`. Make the breaking changes there. Leave `v<N>` untouched.
3. Nothing in the generic engine (`transport.ts`, `loader.ts`, `app.ts`, `router.ts`) needs to change.
4. Nothing to register: bundles are discovered from `engine/routers/v<N>/router.ts`. Update the tests (`engine/app.test.ts` version cases), README, `docs/Authoring.md` and CHANGELOG, and the Storybook title will pick up the new version prefix automatically.

## Bumping versions

There are four independent version numbers. Bump the right one:

| What changed | Where the version lives | How to bump |
| --- | --- | --- |
| **A template** (schema, subject or the document it builds) | `metadata.version` in the template's `index.tsx`, semver | Compatible change: bump minor or patch in place (`1.0.0` to `1.1.0`). Breaking change for callers (required field added, field removed or retyped, meaning changed): do **not** bump the major in place. Copy it into the next version directory as `<N+1>.0.0` (see "Add a router"), because the major must equal the directory's `vN`. The contract test fails on a mismatch. |
| **A router** (API shape) | The `vN` in `engine/routers/vN/`, with `templates/vN/` | Never edit a released `vN` incompatibly. Compatible additions (a new optional field or route) may go into the existing router; anything else is a new `v<N+1>`. There is no per-router semver. |
| **A transport** | The `vN` directory it sits in. Transports have **no version field of their own**. | Fixes and provider-side changes inside the adapter that keep the contract are made in place, and recorded in the CHANGELOG. A change to the shared contract (the envelope, `send` signature or result shape) is a new transport contract (`engine/routers/v<N+1>/transport.ts`, in a new bundle) and a new `transports/v<N+1>/`. |
| **The engine** (the package and image) | `version` in `package.json`, semver, and the CHANGELOG | Update `package.json` and add a CHANGELOG entry: patch for fixes, minor for backward-compatible features, major for breaking engine changes (such as removing an API version). Tag the release. |

When you bump anything, also: run `npm run typecheck` and `npm test`, note it in [CHANGELOG.md](CHANGELOG.md), and update any README or spec text that quotes the changed shape. A template or transport release does not need an engine release (they are mounted artifacts), but a new router or contract version does, because routers ship inside the engine image.

## Conventions and gotchas

- Strict validation everywhere: unknown properties are rejected, and invalid input never reaches rendering. Building a document is all or nothing; HTML and plaintext are both mandatory and come from the same component.
- Errors use `{ error: { code, message, details? } }`, except the sender's build-layer, envelope, options and request problems, which are a flat `400` (`{ error, sub_error?, description, fields? }`). Internals (paths, stack traces, provider credentials, missing-variable names) are logged, never returned.
- The sender authenticates before doing anything else with a request; keep that ordering.
- Logging: one JSON object per line on stdout, through the engine's logger (`engine/logger.ts`, pino). Inside a request use `req.log`, which carries `request_id` and `api_version`; elsewhere use the logger the router was given (`VersionContext.logger`). Never `console` in `engine/` (the only exception is the no-logger fallback in `versions.ts`). Use stable event names (`mailjot.<area>.<what>`) and put the data in fields, not in the message. **Never log request bodies, subjects, recipients, rendered HTML or text, credentials, headers, the raw URL or query string, or a provider's response or error text**: they leak. Redaction of secret-named keys is only a backstop. `engine/canary.test.ts` sends secrets, recipients and provider echoes through everything and fails if any reaches the log; if it fails after you add a log line, the line leaks, so remove the field (do not edit the test's list). `logger.ts` and `requestLog.ts` are Node-only: no render-path file may import them (`engine/browser-safe.test.ts`).
- The engine's render path (`render.ts`, `integrity.ts`, `schema.ts`, `validation.ts`, `errors.ts`, `template.ts`) runs in the browser inside Storybook, so it must not import Node-only modules **or use Node globals such as `process` or `Buffer`**. Read configuration (like `RENDER_TIMEOUT_MS`) in the router and pass it in as an option. `storybook build` can hide a violation (it substitutes `process.env.*` statically) while `storybook dev` fails with `process is not defined`; `engine/browser-safe.test.ts` guards this, so keep new browser-side files in its list.
- `engine/routers/` compiles with the engine (`tsconfig.engine.json`, which is `composite`); `tsconfig.transports.json` references it so transports can `import type` the contract. `engine/routers/v1/transport.ts` also holds engine-only runtime code; plugins must only ever `import type` from it.
- Tests: no network, no real credentials, deterministic. Inject a logger (`captureLogger()` from `test/captureLogger.ts`, passed as `createApp`'s `logger`) and assert on event names and fields instead of spying on `console`; inject `generateRequestId` when asserting request IDs. Use temporary directories for filesystem cases and `test/fixtures/` for deliberately bad modules. Mailjet's real API has never been exercised by this repository; its adapter is tested against mocked responses and a local stub only.
- Do not put test-only templates or transports in `templates/` or `transports/`; they would ship.
