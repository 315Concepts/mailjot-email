# Changelog

All notable changes to the engine are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com), and versions follow [semver](https://semver.org). Individual templates are versioned separately through `metadata.version`.

Terminology: a **template** is an email that is yet to be built; a **document** is a template that has been built (subject, HTML and plaintext).

## [0.1.0] - Unreleased

First release.

### Added
- Directory-based API versioning: `templates/v<N>/` is served at `/v<N>`, mounted automatically from the layout. `GET /` lists mounted versions. Each version's router lives in a bundle, `engine/routers/v<N>/` (router, envelope, sender, transport contract), discovered from the layout; a version directory with no router implementation stops startup. `metadata.version` must be semver with a major matching its directory.
- Filesystem-driven template discovery: a directory under a version directory is a template, with no registry or route registration.
- Sender routes: `POST /v1/sender/{transport}/{template}` builds a template into a document and sends it through a pluggable transport; `GET /v1/sender` lists transports. Answer 404 as unknown routes until `transports/v<N>/` holds a transport (checked per request, so no restart is needed to add one). Build-layer failures return a flat `400` with a `sub_error`. Protected by a bearer token (`MAILJOT_TRANSPORT_AUTH_TOKEN`), denied entirely when none is configured; supports `dryRun`.
- Template contract (`schema`, `metadata`, `subject`, `default`, `examples`) with strict Zod validation.
- Rendering pipeline that builds a template into a document (subject, HTML and plaintext) from one React Email component, with integrity checks (empty output, multi-line subjects, unresolved expressions) and no partial output.
- REST API: `POST /v1/render/{template}`, `GET /v1/schemas/{template}`, `GET /v1/templates` (returns `{ templates: [{ template, version, description }] }`), `GET /healthz`, with structured field-level 422 errors.
- JSON Schema generated from the same Zod schema used for validation.
- Storybook preview that builds each template into a document through the real engine (HTML, plaintext, schema, validation feedback).
- Docker images and compose files for production and development.
- Sample templates `accounts/welcome` and `billing/receipt`.
- Startup check for the templates directory, server and render timeouts.
- Each API version's router resolves its own templates, transports, envelope and transport contract from the version's directories; the generic engine is version-agnostic.
- `npm run coverage`: test coverage report (v8) for the engine, transports and templates, in the terminal and as HTML in `coverage/`.
- `scripts/sender` and `scripts/render`: curl wrappers for trying the sender and the render route by hand, with a configurable template (and transport, for `sender`) and request bodies in `scripts/sender-data.json` and `scripts/render-data.json`. Options: `-t TEMPLATE` (`MAILJOT_TEMPLATE`), `-T TRANSPORT` (`MAILJOT_TRANSPORT`, `sender` only), `-f FILE`, `-u URL`.
- Pluggable transports: `transports/v<N>/<Name>/transport.tsx`, discovered and mounted automatically, with a provider-neutral contract (common envelope, optional per-transport `options`, failures returned as values). Mailjet ships as the default transport, alongside `Logging` (one JSON line per message), `Recording` (saves each message as JSON, HTML and plaintext files) and `BlackHole` (swallows each message and logs `Swallowed <n> characters on <n> lines!`) transports that deliver nothing.
- Contract test over every discovered template and every real transport, and a CI workflow.
- Structured JSON logging (pino) on stdout, with `LOG_LEVEL` (default `info`), a request ID on every response (`X-Request-Id`) and on every log line of a request, and one `mailjot.request` access line per request. See "Logging" below.

- Ory Kratos email templates in `templates/v1/ory/` (the 12 courier emails), with `maketmpl` and `gotmpl` scripts that record them through the Recording transport and convert the recordings into Kratos Go templates, as a worked example of using mailjot to design emails for external template systems. See `templates/v1/ory/pipeline.md` and `docs/OrySpec.md`.

### Logging
- One JSON object per line on stdout, with `level`, `time`, `service`, `version`, `request_id` and `api_version` where they apply, and a stable `event` name (`mailjot.<area>.<what>`). The previous free-text `console` lines are gone, including the startup lines and the BlackHole line (now an `info` event whose message is still `Swallowed <n> characters on <n> lines!`). Fatal startup errors are now a JSON `fatal` line on stdout, not text on stderr.
- `X-Request-Id`: a safe caller-supplied ID (up to 64 of `A-Za-z0-9._-`) is echoed; anything else is replaced with a UUID.
- Never logged: request bodies, subjects, recipients, rendered HTML or text, credentials, headers, the raw URL or query string, and a provider's response or error text. Secret-named keys are also redacted as a backstop. Logged with their cause chain: failures, for the operator.
- Transport contract (v1): `TransportMessage` gains `logger`, so transports log through the engine (scoped to the request, transport and template). This changes `v1` in place because it is unreleased. The `Mailjet` transport now logs its outcomes (status, error codes, duration, never the provider's text); `Recording` logs a failed write.
- Known gaps: a request abandoned by the client before the response finishes is not logged; crashes and unhandled rejections still print plain text; the `Logging` transport keeps printing its own line with `console.log`.

### Layout
Templates live in `templates/v<N>/` and the engine source in `engine/` (routers in `engine/routers/`); the compiled entry point is `dist/engine/index.js`. Pre-release layouts (a flat `<group>/<name>` layout, an earlier `documents/` directory, and `src/`) no longer exist.

### Deployment note: mounted templates and transports
The production image contains the engine only. Compiled templates (`npm run template-compiler`) and transports (`npm run transport-compiler`) are separate artifacts mounted read-only at `/app/templates` and `/app/transports`, so the engine, templates and transports are released independently and a release is an atomic swap of the mounted directory. Adding a transport to the mounted directory makes it available without rebuilding the image or restarting the container; editing a transport that has already loaded needs a restart (Node's module cache). The alternative, compiling templates into the engine image, is an exercise left to the user. Templates and transports must be mounted at `/app/templates` and `/app/transports` so their imports resolve against the engine's `node_modules`.

### Known limitations
See the README. Notably: the Mailjet adapter has only been tested against mocked responses, a single shared sender token, no built-in rate limiting, and the HTML of a built document has no charset or viewport meta tag.
