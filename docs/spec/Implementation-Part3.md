# Implementation Part 3 — Versioned API and Pluggable Transports (`/v1/sender`)

Terminology: a **template** is an email that is yet to be built, and a **document** is a template that has been built (subject, HTML and plaintext). A **message** is a document plus its envelope. This plan was written before that vocabulary and has been reworded to match. The API names it mentions use the current vocabulary: the `template` field in responses, the `templates` list, the `template_not_found` and `template_unavailable` error codes, and the `template-compiler` script.

Goals:

1. **Enforce API versioning from the directory layout.** Previously `/v1` was a string typed into three route definitions. Now a version directory (`v1`, `v2`, ...) under `templates/` and `transports/` defines which version exists, and a matching bundle, `engine/routers/v<N>/`, supplies its routes, mounted automatically. (Done in Step 1; templates only so far.)
2. **Add email delivery without touching the rendering engine.** Delivery providers are plugins in `transports/`, discovered and mounted automatically, exactly as templates are. `POST /v1/sender/{transport}/{template}` builds a template into a document, hands the result to the named transport, and reports the transport's response.

Example: `POST /v1/sender/MailJet/accounts/welcome` builds `templates/v1/accounts/welcome` and sends the document with `transports/v1/Mailjet/transport.tsx`.

Repository layout after this part:

```
engine/          # the engine: discovery, loaders, rendering, router discovery
engine/routers/  # one bundle per API version: v1/, v2/, ...
templates/v1/    # templates served at /v1 (mounted, not part of the engine)
transports/v1/   # delivery plugins served at /v1 (mounted, not part of the engine)
```

Prerequisite: Parts 1 and 2 are complete. This part reverses the spec's "no email delivery" scope and changes the templates layout, so [SystemSpec.md](SystemSpec.md) must be updated (Step 0).

## Step 0 — Decisions and spec update

Settle these before building. The assumptions in bold are what the rest of this plan uses.

- **One version number covers the API shape and the templates and transports served under it.** `templates/v1/` holds the templates served at `/v1`; a template's identity is its path within the version directory (`accounts/welcome`). A breaking change (a schema change callers would notice, or a different response shape) creates a `v2` rather than editing `v1`.
- **A version directory is a complete set.** `v2` serves only what is inside `templates/v2/`; there is no fallthrough to `v1`. Unchanged templates are copied (or symlinked). This is explicit and keeps each version independently deployable, at the cost of duplication. The alternative, falling back to the previous version when a template is absent, is rejected as too implicit.
- **A version needs both a directory and code.** Version directories are discovered, but the API shape for a version is code. Each version's router lives in a bundle, `engine/routers/v<N>/` (its `router.ts` default-exports the router factory) and is discovered from the layout, with no central registry. A version directory with no router implementation is a startup error, not a silent 404.
- **`metadata.version` stays a semver string inside a major version**, and its major number must equal the directory's (`v1` templates are `1.x.y`). The contract check enforces this.
- **`/v1/sender` is added alongside the existing render endpoint**, which stays as the preview and integration path. If `/v1/render` should be removed, say so; nothing below depends on it.
- **Transport names match case-insensitively against the directory name.** The example uses `MailJet` in the URL and `Mailjet/` on disk; matching ignores case so both work, and the directory name is canonical.
- **Delivery is opt-in.** No transport files, no working sender routes (they answer 404, decided per request).
- Update SystemSpec.md: replace the template layout with the versioned one, state the versioning rule (all routes live under `/v{n}/`; a released version's request and response shapes are stable), remove email delivery from the out-of-scope list, add a "Transports" section, and add delivery and versioning items to the definition of done.

Done when: the spec reflects versioning and delivery, and these choices are recorded.

Status: done. Recorded in SystemSpec.md: versioning in section 2, endpoints in section 5, deployment in section 8, transports and the sender error shape in the new section 9, and delivery and versioning items 9 to 12 in the definition of done (now section 11).

## Step 1 — Versioned layout and router refactor

Behaviour-preserving: after this step the API at `/v1` responds exactly as it does now.

- Move the templates into `templates/v1/`, and `test/fixtures/templates/` into `test/fixtures/templates/v1/`.
- Discovery gains a version scan: directories matching `v<number>` under the templates root are versions. Anything else at that level is ignored with a startup warning.
- Replace the hardcoded route strings in `engine/app.ts` with a router factory, `createRouter(context)`, default-exported from `engine/routers/v1/router.ts`. `engine/router.ts` discovers `engine/routers/v<N>/router.ts` bundles (and holds the `VersionContext` type), and `createApp` builds one loader per discovered version and mounts the matching router for it. A discovered version with no router fails startup with a clear message; a router with no template directory is simply not mounted.
- `engine/routers/` is part of the engine and compiles with it (`tsconfig.engine.json`, `composite`, `npm run engine-compiler`); entry point `dist/engine/index.js`, routers in `dist/engine/routers/`. Routers import engine internals at runtime, so they are built with the engine and baked into the image, never mounted separately. Transports have their own config: `tsconfig.transports.json` references the engine project (`npm run transport-compiler` is `tsc -b`) so they can `import type` the contract. Only templates and transports are mounted.
- Add `GET /` returning the mounted versions, so clients and operators can see what a deployment serves.
- Unknown versions (`/v9/...`) get the standard JSON 404.
- Contract check: `metadata.version` major equals the directory's version.
- Update everything that knows the old layout: the contract test (iterates every version), the templates-root setting (`TEMPLATES_DIR`, still the templates root, now containing version directories), the startup directory check, `package.json` scripts and tsconfig paths, the Dockerfile (new entry path) and compose mounts (`/app/templates` stays the mount point; `v1/` is inside it; the dev compose mounts `./engine`), CI, README, Testing.md and docs/Authoring.md.
- Storybook: story titles are derived from the file path, which now begins with `v1/`. The story helper sets `title` from `metadata.id`, so make it include the version (`v1/accounts/welcome`) or the indexed and runtime titles will disagree.

Status: done, including the later move of the engine from `src/` to `engine/` with routers in `engine/routers/`, now one bundle per version.

Done when: all existing tests pass against the new layout with only path updates, `/v1/...` responses are unchanged, a throwaway `templates/v2/` with no router makes startup fail with a clear message, and Storybook still lists every template.

## Step 2 — Transport contract and discovery

Mirror the template runtime, in a new versioned `transports/` directory next to `templates/`.

- Each transport is a directory `transports/v1/<Name>/` whose `transport.tsx` (or compiled `transport.js`) exports the following, with tests alongside as `transport.test.tsx`. The version's contract types are owned by the engine, in `engine/routers/v1/transport.ts`:

  | Export | Responsibility |
  | --- | --- |
  | `metadata` | `{ id, description }`; `id` must match the directory name |
  | `config` | Zod schema over environment variables (API keys, endpoints) |
  | `options` | Optional Zod schema for provider-specific extras; default is "no options" |
  | `default` | `send({ template, version, subject, html, text, envelope, options, config })`, resolving to `{ ok: true, messageId?, response }` or `{ ok: false, reason: "rejected" \| "unreachable", message, response? }` (`document` and `version` identify the template the document was built from) |

- **The contract is provider-neutral.** The engine owns one envelope (`from`, `to`, `cc`, `bcc`, `replyTo`, in `engine/routers/v1/envelope.ts`) and validates it before a transport sees it, so callers can switch providers without changing requests. Provider specifics go in the optional `options` schema, and translation to the provider's API happens inside the transport file.
- **Failures are values, not exceptions.** Transports are compiled and mounted separately from the engine, so they never import engine classes at runtime. The contract is owned by the engine, one per version, `engine/routers/v1/transport.ts`: its types are what transports import (`import type` only), and its runtime check is used only by that version's router. An exception escaping `send` is an internal error.

- Discovery scans `transports/<version>/` for `<Name>/transport.tsx` (or compiled `transport.js`) directories, using the same version scan as templates. Names are safe-pattern checked and matched case-insensitively; two files whose names differ only in case are a startup error.
- Config is validated when the transport is loaded. A transport with missing or invalid config is listed as unavailable and returns 503 on use; the engine does not crash.
- Add `tsconfig.transports.json` and a `transport-compiler` npm script (also part of `npm run build`). `TRANSPORTS_DIR` (default `./transports`) is wired into the app in Step 4.
- **Mailjet ships as the default transport** (`transports/v1/Mailjet/transport.tsx`, built in this step; see Step 5 for its details). It is an adapter over the generic contract, not the shape of it.

Status: done (engine side: `engine/transport.ts`, `engine/routers/v1/envelope.ts`, `engine/routers/v1/transport.ts`; Mailjet adapter with mocked-`fetch` tests; fixtures in `test/fixtures/transports/v1/`). Not yet wired to HTTP.

Done when: unit tests discover a sample transport, reject a malformed one, and resolve names safely (case-insensitively, no traversal).

## Step 3 — Sender pipeline

- Request body: `{ "envelope": { ... }, "options": { ... }, "input": { ... } }`. `input` is the template's input, unchanged; `envelope` is validated by the engine's common envelope schema; `options` (optional) by the transport's own `options` schema. Keeping them separate means the strict template schema never needs to know about delivery.
- Order: resolve transport and template, validate and build the document (existing `renderTemplate`), validate the envelope, call `send`.
- Nothing is sent unless the template builds fully and the envelope is valid.
- Success response, 200: `{ "transport": "Mailjet", "template": "accounts/welcome", "version": "1.0.0", "subject": "...", "response": <transport response> }` (`template` and `version` identify the template the document was built from). `response` is whatever the transport returns, passed through.
- A transport result with `ok: false` returns 502 with the same shape plus the provider's response (`rejected` and `unreachable` are both 502; the reason is reported). Misconfiguration returns 503.

Status: done (`engine/routers/v1/sender.ts`). The success body also carries the provider's `messageId` when the transport supplies one, and a `{ ok: false }` result becomes a 502 in the standard error shape with `details: { transport, template, reason, response }`.

Done when: tests with a fake transport cover a successful send, no send on any build failure, and no send on a bad envelope.

## Step 4 — Sender routes and error shape

- Add the sender routes to the v1 router in `engine/routers/v1/router.ts`, so they exist only under `/v1`. A future `v2` router can change them without touching `v1`.
- `POST /v1/sender/{transport}/{template}`: the first path segment is the transport, the rest is the template path, resolved through the existing safe resolver against `templates/v1`.
- `GET /v1/sender`: lists discovered transports with their description, availability, and envelope JSON Schema (generated from the Zod schema, as for templates).
- **Build-layer failures return a flat 400**, not the nested error object used elsewhere:

  ```json
  { "error": "render_failed", "sub_error": "validation_failed", "description": "Input validation failed", "fields": [ { "path": ["name"], "code": "invalid_type", "message": "..." } ] }
  ```

  | `sub_error` | When | Extra fields |
  | --- | --- | --- |
  | `validation_failed` | The input failed the template's schema | `fields` (the same field errors as 422 today) |
  | `integrity_failed` | Empty output, bad subject, or an unresolved expression in the document | `description` names the failed check |
  | `render_failed` | The template's component threw | `description` is generic; internals stay in the server log |

  Envelope and options validation failures use the same flat shape with `"error": "invalid_envelope"` or `"invalid_options"` and `fields`.
- Other statuses: 404 unknown transport or template, 413/415/400 as today for the body, 502 provider rejection, 503 transport unavailable.
- Note the tradeoff: a bug in a template's component now surfaces as a 400 instead of a 500. Alerting on `sub_error: render_failed` in logs is how operators will notice.
- Sender routes are mounted whenever a transports directory is configured, and each request first checks that `transports/v<N>/` currently holds a transport; with none they answer 404 like any unknown route, so delivery stays opt-in and a transport added while the server runs needs no restart. `TRANSPORTS_DIR` is read by `engine/index.ts` (default `./transports`). A transport that throws is a bug and returns a generic 500; `GET /v1/sender` reports unavailable transports without saying why (the reason is logged).

Status: done (`engine/routers/v1/router.ts`, `engine/routers/v1/sender.ts`; HTTP tests in `engine/sender.test.ts`). Also checked end to end with the compiled engine and compiled Mailjet against a local stub of the Mailjet API.

Done when: every row above has an HTTP-level test, including that internal messages never appear in the body.

## Step 5 — Transports: MailJet and a test transport

- `transports/v1/Mailjet/transport.tsx` (done in Step 2): an adapter over the generic contract, using `fetch` against the Send API v3.1 (no SDK dependency). Config from `MAILJET_API_KEY`, `MAILJET_API_SECRET` and optional `MAILJET_API_URL`; options `sandbox` and `customId`. The generic envelope is translated to Mailjet's request in one function; Mailjet's response and errors (non-2xx, per-message errors, 5xx, non-JSON, network failure) are translated into a `SendResult`. The Mailjet request and response shapes come from my knowledge of their API and should be checked against their current docs and a sandbox send.
- Tests mock `fetch`; no network in the test suite (done).
- `test/fixtures/transports/v1/`: an in-memory transport used by the HTTP tests, plus broken, failing, unconfigured and throwing ones, following the `test/fixtures/templates/` pattern. These are never built or mounted for real (done).

Status: done in code. Still open: the one-off manual check against the real Mailjet API with real credentials, which needs your account. The README ("Trying Mailjet safely") gives the safe way: `options.sandbox` makes Mailjet validate without delivering. The compiled Mailjet transport was also exercised through the compiled engine against a local stub of the Mailjet API.

Done when: Mailjet's request mapping and error mapping are covered by tests, and a manual send with real credentials is checked once outside CI.

## Step 6 — Safety before enabling

An HTTP endpoint that sends email is an abuse target, unlike render-only. Before this is deployed:

- Require authentication on `/v1/sender`: a bearer token from the `MAILJOT_TRANSPORT_AUTH_TOKEN` environment variable; deny all requests if it is unset or shorter than 16 characters. Authentication runs before any other processing, and the comparison is constant-time. (`engine/auth.ts`)
- A `dryRun` flag in the body that builds and validates the document, envelope and options but does not call `send`.
- Write down rate-limiting guidance for the sender routes specifically (README, "Rate limiting / deployment guidance").
- Decided against recipient or domain allowlists: the token is the only access control.

Status: done. `MAILJOT_TRANSPORT_AUTH_TOKEN` is passed through by both compose files; the startup log states whether authentication is enabled.

Done when: unauthenticated requests are rejected with 401, and dry-run is tested.

## Step 7 — Packaging and docs

- Dockerfile, `docker-compose.yml`, `docker-compose.dev.yml`: mount compiled transports read-only at `/app/transports`, alongside templates (each containing its version directories). Routers are part of the engine image, not mounted. Add a `transport-compiler` step to `npm run build` and the Dockerfile as needed, and keep `npm start` pointing at `dist/engine/index.js`.
- CI: build the transports compile target; the contract test also covers every real transport's exports and config schema, in every version.
- README: versioning rules and layout, `/v1/sender` usage, the flat error shape, and how to write a transport. docs/Authoring.md: how to add a new version; docs/Sending.md: the sender and a transport-authoring guide. CHANGELOG: new minor version, noting the layout move.

Status: done. Checked with the production image (non-root, read-only filesystem): `POST /v1/sender/mailjet/accounts/welcome` sent through the mounted compiled Mailjet transport to a local stub of the Mailjet API on the compose network (the stub saw the Basic auth header and the translated message). A compiled-only `Echo` transport was then added to the mounted directory and the container restarted: it was discovered and used with the same image id, so transports release independently. The contract test now also covers every real transport (`engine/contract.test.ts`). Mounted transports must sit at `/app/transports`; the stub could not be reached from the host side of the Docker bridge in this environment, so it ran as a container.

Done when: the production container sends through a mounted compiled transport (using the in-memory transport or a sandbox account), with templates and transports released independently.

## Follow-up — Routers resolve their own version

After Step 7 the generic engine still imported the v1 transport contract and built the loaders for the routers. Now `engine/app.ts` is version-agnostic: it hands each router a `VersionContext` (`version`, `templatesDir` for the version's templates, `transportsDir`, `env`), and the router builds its own template loader, its own transport loader with its own contract, and owns its sender and envelope. v1-specific code is in the `engine/routers/v1/` bundle; `engine/transport.ts` takes a `TransportContract` instead of importing one. A router factory may be async.

Done when: the generic modules mention no version, a router is given only its own version's directories (tested with a two-version layout), and a fake contract can drive the generic loader (tested).

## Follow-up — One bundle per version

The v1-specific modules (router, envelope, sender, transport contract) now live together in `engine/routers/v1/` instead of as `*.v1.ts` files beside the generic engine. `loadVersionRouters` scans `engine/routers/` for `v<N>/` directories and imports each bundle's `router.ts` (or compiled `router.js`); it fails clearly if a bundle has no router module or the module has no default-exported function. A new API version is a copy of the bundle. Plugins still `import type` the contract, now from `engine/routers/v1/transport.ts`.
