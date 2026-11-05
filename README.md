# mailjot

A modern email rendering service where each email is a schema-validated and REST-exposed React component that simultaneously generates both HTML and plaintext documents. Design, build, and send emails, all from the same stack - and stop guessing about what's going to land in the inbox.

## Quick start

Requires Node.js 24 and npm.

```
npm install
npm run dev          # API on http://localhost:3000, restarts on change
npm run storybook    # template preview on http://localhost:6006
npm test
```

To run the compiled output instead of TSX: `npm run build && npm start`.

Build the sample template into a document:

```
curl -X POST localhost:3000/v1/render/accounts/welcome \
  -H 'Content-Type: application/json' \
  -d '{"name":"Alice"}'
```

```json
{
  "template": "accounts/welcome",
  "version": "1.0.0",
  "subject": "Welcome aboard, Alice!",
  "html": "<!DOCTYPE html>...",
  "text": "Welcome aboard, Alice!"
}
```

The response is the built email document, including both plaintext and full HTML versions. Its `template` and `version` fields identify the template it was built from.

## Project terminology

- A **template** is an email that is yet to be built: a directory of source with a Zod schema for its input, a React Email component, a subject and examples. Templates are authored, versioned and compiled. They live in `templates/v[X]/`.
- A **document** is a template that has been built: the subject, HTML and plaintext produced by rendering a template with an input. Documents are what the render route returns and what transports deliver.
- A **message** is a document together with its envelope (who it is from and to), which is what a transport receives.

Building a template into a document means rendering it with an input value. It has nothing to do with `npm run build`, which compiles the engine source code.

## Templates

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/templates` | List available templates |
| GET | `/v1/schemas/{template}` | JSON Schema, version, description and examples |
| POST | `/v1/render/{template}` | Validate the payload and build the template into a document |

A template is a directory inside a `templates/` version directory. The template's path within that version is its identity, and the version directory defines the engine router version it is served under: `templates/v1/billing/receipt` is `billing/receipt` using the `/v1` engine router.

### Sending

Delivery is optional. If `transports/v1/` contains transports, the sender routes work; otherwise they answer 404 like any unknown route. This is checked on every request, so adding a transport needs no restart (editing one that has already loaded does). Mailjet ships as the default transport, with `Logging`, `Recording` and `BlackHole` transports (nothing delivered) for development and testing.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/sender` | List transports, the common envelope schema and each transport's options |
| POST | `/v1/sender/{transport}/{template}` | Build a template into a document and send it through a transport |

```
curl -X POST localhost:3000/v1/sender/Mailjet/accounts/welcome \
  -H "Authorization: Bearer $MAILJOT_TRANSPORT_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "envelope": { "from": { "email": "hi@example.com", "name": "Hi" }, "to": [{ "email": "alice@example.com" }] },
    "input": { "name": "Alice" }
  }'
```

Try it from the command line with `MAILJOT_TRANSPORT_AUTH_TOKEN=... scripts/sender`, or `scripts/render` to see the document a template builds without sending anything (see [docs/Sending.md](docs/Sending.md)). Sender routes need a bearer token (`MAILJOT_TRANSPORT_AUTH_TOKEN`; without one every request gets `401`), and build-layer problems come back as a flat `400` with a `sub_error`. The full request, error, authentication and dry-run reference is in [docs/Sending.md](docs/Sending.md). To write a transport, see "Writing a transport" in the same document.

## API

Errors use one shape: `{ "error": { "code", "message", "details?" } }`.

| `code` | Status | When |
| --- | --- | --- |
| `bad_request` | 400 | The body is not valid JSON, or is otherwise malformed |
| `unsupported_media_type` | 415 | `Content-Type` is not `application/json` |
| `payload_too_large` | 413 | The body is over 1 MB |
| `validation_failed` | 422 | The payload failed the template's schema; `details` lists `{ path, code, message }` per field |
| `template_not_found` | 404 | Unknown template, or a path that is not a valid template path |
| `not_found` | 404 | Unknown route, or an API version that is not mounted |
| `render_failed` | 500 | The template's component threw |
| `integrity_failed` | 500 | The built document failed an integrity check (empty output, multi-line subject, unresolved expression) |
| `template_unavailable` | 500 | The template exists but violates the template contract |
| `internal_error` | 500 | Anything unexpected |

Responses for 5xx errors are generic; the details are only logged. The sender routes add four more codes (`unauthorized` 401, `transport_not_found` 404, `send_failed` 502 and `transport_unavailable` 503) and report build-layer and request problems in a different, flat 400 shape; see [docs/Sending.md](docs/Sending.md).

## Node Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | API with restart on change (templates run from TSX) |
| `npm run build` | Compile the engine, templates and transports to `dist/` |
| `npm start` | Run the compiled engine against `dist/templates` and `dist/transports` (run `npm run build` first) |
| `npm test` | Run all tests |
| `npm run coverage` | Run all tests and write a coverage report to `coverage/` (HTML and a terminal table) |
| `npm run typecheck` | Typecheck everything, including tests and stories |
| `npm run storybook` | Template preview on port 6006 |
| `npm run build-storybook` | Static Storybook build |
| `npm run engine-compiler` | Compile only the engine and its version routers, into `dist/engine` (entry point `dist/engine/index.js`) |
| `npm run template-compiler` | Compile only the templates, into `dist/templates` |
| `npm run transport-compiler` | Compile only the transports, into `dist/transports` |

Configuration is by environment variable: `PORT` (default 3000), `TEMPLATES_DIR` (default `./templates`), `TRANSPORTS_DIR` (default `./transports`), `LOG_LEVEL` (default `info`; see "Logging"), and each transport's own settings (for Mailjet, `MAILJET_API_KEY`, `MAILJET_API_SECRET`, and optionally `MAILJET_API_URL`).

## Logging

The engine writes one JSON object per line to stdout, so `docker compose logs` and any log shipper can read it. Set the verbosity with `LOG_LEVEL` (`trace`, `debug`, `info`, `warn`, `error`, `fatal` or `silent`; default `info`; an unknown value logs one warning and uses `info`).

```json
{"level":"info","time":"2026-11-01T21:18:32.221Z","service":"mailjot","version":"0.1.0","request_id":"a3c9fa6e-aee6-429a-a2ea-efe30e38d257","api_version":"v1","event":"mailjot.request","method":"POST","route":"/v1/render/*template","status":200,"duration_ms":33,"bytes_out":857,"template":"accounts/welcome","msg":"POST /v1/render/*template 200"}
```

**What is never logged:** request bodies, subjects, recipient addresses, the rendered HTML or text, credentials, request headers, the raw URL or query string, and a provider's response or error text (it can echo a recipient). Failures are logged with their cause (message, stack and the chain of causes) so you can debug them, and the caller gets only the generic error. Keys that look like secrets (`authorization`, `token`, `*_API_KEY`, `password`, ...) are also redacted if they ever reach the logger, but that is only a backstop.

To read the log in development, pipe it through a formatter. Use `npm run dev --silent`, because without `--silent` npm prints its own banner lines to stdout and a formatter chokes on them: `npm run dev --silent | jq` (or `| npx pino-pretty`).

## Rate limiting / deployment guidance

mailjot has no built-in rate limiting, and only the sender routes are authenticated. Run it behind a reverse proxy or API gateway (nginx, Caddy, Traefik, a cloud load balancer) that terminates TLS and enforces rate limits and access control, and do not expose it directly to the public internet. The engine itself enforces a 1 MB request body limit, tightened Node server timeouts (headers 10s, request 30s) and a render timeout (`RENDER_TIMEOUT_MS`, default 10s; it bounds async work only, not synchronous CPU-bound code). It exits at startup if `TEMPLATES_DIR` is missing or unreadable.

**Sender routes need stricter limits than rendering.** Every accepted sender request can send a real email through your provider account, so a leaked token or a loop in a caller costs money and sender reputation, not just CPU. Rate-limit `/v[X]/sender` separately from the render routes at the proxy, with a low per-client request rate and a small burst; for example, in nginx, `limit_req_zone $binary_remote_addr zone=sender:10m rate=5r/s;` and `limit_req zone=sender burst=10 nodelay;` on `location /v1/sender`. Prefer to reach the sender routes only from your own backend (a private network, or network rules at the proxy) rather than from browsers, keep `MAILJOT_TRANSPORT_AUTH_TOKEN` in a secret store, and watch your provider's own sending limits and alerts as a second line of defence.

## Known limitations
- Templates control their own `<Head>` content; the engine does not inject a charset meta tag, a viewport tag or a width. Add them in the template if your target clients need them.
- Dark mode, Outlook (Word renderer) and image blocking behaviour depend on each template's markup.
- Tailwind's `pixelBasedPreset` converts spacing and font sizes to pixels but leaves border radius, max width and letter spacing in `rem`/`em`; a template that uses those should pin them to pixels in its own config (see "Using Tailwind" in [docs/Authoring.md](docs/Authoring.md)).

## Docker

The production image contains the _engine only_. The compiled templates and transports are mounted read-only at `/app/templates` and `/app/transports`, so the engine, templates and transports can be released independently. The compose file mounts `./dist/templates` and `./dist/transports` read-only and passes environment variables through from your shell or a `.env` file (a transport without its credentials is reported as unavailable).

```
npm run template-compiler   # compile the templates into dist/templates
npm run transport-compiler  # compile transports into dist/transports
docker compose up --build   # serve them from the engine image
```

For development with the templates and source mounted and Storybook alongside:

```
docker compose -f docker-compose.dev.yml up --build
```

Templates and transports must be mounted at `/app/templates` and `/app/transports` so that their imports (`zod`, `react`, ...) resolve against the engine's `node_modules`.

## Calling it manually

### scripts/render

`scripts/render` is a curl wrapper for running the render engine by hand: it calls `POST /v1/render/{template}`, which needs no authentication and only builds the document, so it shows what a template produces without involving delivery.

```
scripts/render                                              # accounts/welcome, body from scripts/render-data.json
scripts/render -t billing/receipt -f receipt-input.json     # a different template needs a body that fits it
scripts/render 2>/dev/null | jq -r .html > welcome.html     # just the HTML, ready to open in a browser
```

| Option | Environment variable | Default |
| --- | --- | --- |
| `-t TEMPLATE` | `MAILJOT_TEMPLATE` | `accounts/welcome` |
| `-f FILE` | `MAILJOT_RENDER_BODY` | `scripts/render-data.json` |
| `-u URL` | `MAILJOT_URL` | `http://localhost:3000` |

The body is the template's input itself ([scripts/render-data.json](../scripts/render-data.json) is `{ "name": "Alice" }`), not the sender's `{ "envelope", "input" }` wrapper, so the two scripts' body files are not interchangeable. A body that does not fit the template comes back as the render route's standard `422` error. `scripts/render -h` prints the full help.

### scripts/sender

`scripts/sender` is a curl wrapper for running the transport layer by hand. It sends a JSON body from a file (`curl --data-binary @file`), to a configurable template and transport:

```
export MAILJOT_TRANSPORT_AUTH_TOKEN=...          # the token the service was started with
scripts/sender                                   # Logging transport, accounts/welcome, body from scripts/sender-data.json
scripts/sender -T Recording                      # another transport, same body
scripts/sender -t billing/receipt -T Mailjet -f my-receipt.json
```

| Option | Environment variable | Default |
| --- | --- | --- |
| `-t TEMPLATE` | `MAILJOT_TEMPLATE` | `accounts/welcome` |
| `-T TRANSPORT` | `MAILJOT_TRANSPORT` | `Logging` |
| `-f FILE` | `MAILJOT_SENDER_BODY` | `scripts/sender-data.json` |
| `-u URL` | `MAILJOT_URL` | `http://localhost:3000` |

The default transport, Logging, delivers nothing, so running it with no arguments is safe. [scripts/sender-data.json](../scripts/sender-data.json) is a complete body for `accounts/welcome` (`envelope`, `input`, and `"dryRun": false`; set it to `true` to build and validate without sending). A different template needs a body that fits its schema, so pass your own file with `-f`. `scripts/sender -h` prints the full help.

## External pipelines

Some systems send their own emails from templates they render themselves, so they never call mailjot (Ory Kratos renders Go templates). Mailjot can still be the design studio for them: design the email as a template here (React Email, Tailwind, a schema, a Storybook preview), build it once through the Recording transport with ALL_CAPS stand-in values, then convert the stand-ins into the other system's own expressions and ship the resulting static files to it. Mailjot is not involved after that. The stand-ins are strings because the engine refuses to build a document containing `{{ }}`.

The worked example is a set of [Ory Kratos email templates](https://www.ory.com/docs/kratos/self-hosted/mail-courier-templates) in `templates/v1/ory/`, with two scripts: `maketmpl` records each template through a running server and `gotmpl` converts the recordings into Kratos Go templates. See [templates/v1/ory/pipeline.md](templates/v1/ory/pipeline.md) for the steps and its limits, and [docs/OrySpec.md](docs/OrySpec.md) for the parameters of every Kratos email.

## More documentation

- [docs/Architecture.md](docs/Architecture.md): components, startup, request flows and deployment
- [docs/Authoring.md](docs/Authoring.md): setup, checks, and adding templates and API versions
- [docs/Sending.md](docs/Sending.md): the sender routes, errors, authentication, dry run, and writing a transport
- [docs/Storybook.md](docs/Storybook.md): writing and using template stories
- [docs/Testing.md](docs/Testing.md): testing guidelines
- [templates/v1/ory/pipeline.md](templates/v1/ory/pipeline.md): using mailjot as a design studio for external template systems (Ory Kratos is the example)
- [docs/OrySpec.md](docs/OrySpec.md): every Ory Kratos email and its template parameters
- [docs/spec/SystemSpec.md](docs/spec/SystemSpec.md): the technical specification
- [docs/spec/Implementation-Part1.md](docs/spec/Implementation-Part1.md), [Part2](docs/spec/Implementation-Part2.md), [Part3](docs/spec/Implementation-Part3.md): build plan, release checklist, versioning and transports
- [CHANGELOG.md](CHANGELOG.md): release notes

## License

[MIT](LICENSE)
