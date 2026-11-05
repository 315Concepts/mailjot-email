# Sending

Delivery is optional. If `transports/v1/` contains transports, the sender routes work; otherwise they answer 404 like any unknown route. This is checked on every request, so adding a transport needs no restart (editing one that has already loaded does). Four transports ship: **Mailjet** (real delivery), and **Logging**, **Recording** and **BlackHole** (deliver nothing; see "Built-in transports"). To write another one, see "Writing a transport" below.

The sender builds a **template** into a **document** (the subject, HTML and plaintext) and hands it, with an envelope, to a transport. That pairing is a **message**.

## Routes

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/v1/sender` | List transports, the common envelope schema and each transport's options |
| POST | `/v1/sender/{transport}/{template}` | Build a template into a document and send it through a transport |

```
curl -X POST localhost:3000/v1/sender/Mailjet/accounts/welcome \
  -H 'Content-Type: application/json' \
  -d '{
    "envelope": { "from": { "email": "hi@example.com", "name": "Hi" }, "to": [{ "email": "alice@example.com" }] },
    "options": { "customId": "order-1" },
    "input": { "name": "Alice" }
  }'
```

`input` is the template's input, `envelope` is the same for every transport (`from`, `to`, `cc`, `bcc`, `replyTo`), and `options` (optional) is validated by the transport itself. Transport names match case-insensitively. Success returns `{ transport, template, version, subject, messageId?, response }`, where `template` and `version` identify the template the document was built from and `response` is the provider's own response. Nothing is sent unless the template builds completely and the envelope and options are valid.

Build-layer and request problems return a **flat** `400`, not the nested error object (`{ "error": { "code", "message", "details?" } }`) used by the other routes:

```json
{ "error": "render_failed", "sub_error": "validation_failed", "description": "Input validation failed", "fields": [ { "path": ["name"], "code": "invalid_type", "message": "..." } ] }
```

| `error` | `sub_error` | Meaning |
| --- | --- | --- |
| `render_failed` | `validation_failed` | The input failed the template's schema; `fields` lists the errors |
| `render_failed` | `integrity_failed` | The built document failed an integrity check; `description` names it |
| `render_failed` | `render_failed` | The template's component threw; details are only logged |
| `invalid_envelope` / `invalid_options` | | The envelope or options failed validation; `fields` lists the errors |
| `invalid_request` | | The body is not `{ envelope, input, options? }` |

Everything else uses the standard error object (`{ "error": { "code", "message", "details?" } }`):

| `code` | Status | When |
| --- | --- | --- |
| `unauthorized` | 401 | The bearer token is missing, wrong, or no usable token is configured |
| `transport_not_found` | 404 | Unknown transport name |
| `template_not_found` | 404 | Unknown template |
| `bad_request` / `unsupported_media_type` / `payload_too_large` | 400 / 415 / 413 | The body is malformed JSON, not `application/json`, or over 1 MB |
| `send_failed` | 502 | The provider refused the message or could not be reached; `details` is `{ transport, template, reason, response }`, where `template` is the template's path, `reason` is `rejected` or `unreachable` and `response` is the provider's own response |
| `transport_unavailable` | 503 | The transport is not configured (missing credentials) or violates the transport contract |
| `internal_error` | 500 | Anything unexpected, such as a transport that throws |

The remaining codes are shared with the other routes; see the README. Configure Mailjet with `MAILJET_API_KEY` and `MAILJET_API_SECRET`; a transport without its credentials is listed as unavailable. A bug in a template's component shows up here as a `400` rather than a `500`, so alert on `sub_error: render_failed` in your logs.

## Built-in transports

| Transport | What it does | Configuration | Options |
| --- | --- | --- | --- |
| `Mailjet` | Sends through the Mailjet Send API (v3.1) | `MAILJET_API_KEY`, `MAILJET_API_SECRET`, optional `MAILJET_API_URL` | `sandbox`, `customId` |
| `Logging` | Writes each message to the log as one JSON line. Nothing is delivered. | optional `LOGGING_INCLUDE_BODY` (`true` or `false`, default `false`) | `label` |
| `Recording` | Saves each message to a directory as `message.json`, `message.html` and `message.txt`. Nothing is delivered. | `RECORDING_DIR` (required) | `tag` |
| `BlackHole` | Swallows each message and logs how much. Nothing is delivered or kept. | none | none |

The envelope (`from`, `to`, `cc`, `bcc`, `replyTo`) is the same for all of them, so you can switch a request between transports by changing the name in the URL. Logging, Recording and BlackHole are for development, staging and testing: they exercise the whole pipeline (authentication, building the document, validation) without sending mail.

**Logging** writes a line like `{"event":"mailjot.message","at":"...","id":"log-...","label":"...","template":"accounts/welcome","version":"1.0.0","subject":"...","envelope":{...},"bytes":{"html":685,"text":22}}` to stdout, so it appears in `docker compose logs`. In that line `template` and `version` identify the template the document was built from. Bodies are left out unless `LOGGING_INCLUDE_BODY=true`. The line contains recipient addresses, so treat the log accordingly. Because the line is JSON, a hostile subject or body cannot forge extra log lines. The returned `messageId` is the line's `id`. It is written with `console.log`, not the engine's logger, because printing the message is its whole job: `LOG_LEVEL` does not silence it and it has no `request_id`.

**Recording** writes `<RECORDING_DIR>/<id>/` where the id is a UTC timestamp plus a random suffix (`2026-11-01T02-33-16-575Z_c8d877cb`), and returns it as `messageId`. `message.json` holds the id, time, `tag`, `template` and `version` (the template it was built from), subject and envelope; the HTML and plaintext are the document's bodies exactly as built, so you can open `message.html` in a browser. A recording appears all at once (it is written to a temporary directory and renamed). Nothing in the request can choose the path. If the directory cannot be written, the response is a `502` with `reason: "unreachable"` and a generic message; the real cause is logged. `RECORDING_DIR` is required so nothing is written anywhere by accident: without it the transport is listed as unavailable and returns `503`.

**BlackHole** does what it says: the message goes in and nothing comes out, but it is never silent. Each message that reaches it produces exactly one log line, at `info`, whose message is `Swallowed <characters> characters on <lines> lines!`, for example `Swallowed 707 characters on 2 lines!`. It is a structured line like the engine's own (event `mailjot.transport.blackhole.swallowed`, with `characters` and `lines` as fields, and the request's `request_id`), so `LOG_LEVEL=warn` hides it. The counts cover the document's HTML and plaintext body together. Characters are Unicode code points (an emoji counts once, and a newline counts as a character), and lines are newline-separated lines (a trailing newline does not start another line, and an empty body has none). The wording is fixed and not pluralised, so `1 characters on 1 lines!` is intended and easy to grep for. The line contains only the two numbers (and the usual request fields), never message content. The response is `{ "swallowed": true, "characters": N, "lines": M }`. Requests that are rejected (bad input for the template, bad envelope, any option, since BlackHole takes none) and dry runs never reach it, so they log nothing. It needs no configuration, which makes it handy for load tests and for checking that authentication and building the document work end to end.

## Authentication

Sender routes (and only those) require `Authorization: Bearer <token>`, where the token is the value of the `MAILJOT_TRANSPORT_AUTH_TOKEN` environment variable. Without a token of at least 16 characters configured, every sender request is rejected with `401`, and the startup log says so. Generate one with `openssl rand -hex 32`. A missing, malformed or wrong credential gets the same `401` (with `WWW-Authenticate: Bearer`), before anything else about the request is looked at, so unauthenticated callers cannot learn which transports or templates exist. The token is compared in constant time. There is one shared token; rotate it by restarting with a new value.

## Dry run

Add `"dryRun": true` to the body to build the document and validate everything (the template's input, the envelope and the options) without calling the provider. The response is `{ transport, template, version, subject, dryRun: true, html, text }`. Use it to check a request before sending, and in tests.

## Trying Mailjet safely

Set `"options": { "sandbox": true }` to have Mailjet validate the message on its side without delivering it. This is the way to check your credentials and the request mapping against the real API once, outside CI: send to your own address with `sandbox` and a `dryRun` of `false`, and expect a `200` with a Mailjet response.

## Writing a transport

A transport delivers a built document through one provider. Start by copying `transports/v1/Logging/` (the default transport) and keep the provider's details inside your directory:

```
transports/v1/<Name>/
├── transport.tsx        # the module (see below)
└── transport.test.tsx   # tests, with the provider's HTTP calls mocked
```

`transport.tsx` must export:

| Export | What it is |
| --- | --- |
| `metadata` | `{ id, description }`. `id` must equal the directory name. |
| `config` | Zod schema over environment variables (keys, endpoints). Name variables in `UPPER_SNAKE_CASE`. |
| `options` | Optional Zod schema for provider-specific extras. It must accept `{}`, because a missing `options` is treated as empty. Use `z.strictObject`. |
| `default` | `send(message)`, returning a result. The message includes a `logger` (see "Logging from a transport"). |

The contract for API v1 is in `engine/routers/v1/transport.ts`; import its types with `import type` only. Transports are compiled and mounted separately from the engine, so they must not import engine code at runtime. The `/v1` routes load transports from `transports/v1/` and check them against the v1 contract; a future API version loads its own `transports/v[X]]/` against its own contract.

Guidelines:

- **Stay provider-neutral at the boundary.** You receive the engine's common envelope (`from`, `to`, `cc`, `bcc`, `replyTo`), already validated, plus the built document's `subject`, `html` and `text`, and the `template` and `version` of the template it was built from. Translate to the provider's API inside your directory. Do not change the shared envelope for one provider; put provider-specific extras in `options`.
- **Failures are values.** Return `{ ok: false, reason: "rejected", message, response? }` when the provider refuses the message (bad address, auth, quota), and `reason: "unreachable"` when it cannot be reached or does not answer usefully (network errors, 5xx, non-JSON bodies). Return `{ ok: true, messageId?, response }` on success; `response` is passed to callers unchanged. Do not throw for expected failures; an exception is a bug and becomes a generic 500.
- **Never leak credentials or internals.** Messages and responses you return reach the caller. Do not include keys, authorization headers or raw network error text.
- **Log through `message.logger`, and log events, not content.** See "Logging from a transport".
- **Time-box the request** (for example `AbortSignal.timeout(15_000)`) so a slow provider cannot hang a request.
- **Test without the network.** Mock `fetch` and cover the request mapping, success, rejection, 5xx, non-JSON and network failure. Never put real credentials in tests.
- **Use the config schema for availability.** A transport whose config fails is listed as unavailable and returns `503`; it does not crash the engine. Check your config schema with an empty environment.

A new transport is picked up automatically (no registration) when `transports/<version>/` is mounted. Test transports for the engine itself (in-memory, failing, throwing, ...) go in `test/fixtures/transports/`, never in `transports/`.

Try a transport safely with `dryRun` (see "Dry run"; it builds and validates without sending), and, where the provider offers one, a sandbox mode (Mailjet: `"options": { "sandbox": true }`), described above.

## Logging from a transport

Every message a transport receives includes a `logger` (`TransportLogger` in `engine/routers/v1/transport.ts`: `debug`, `info`, `warn` and `error`, each taking a fields object and a short message). It is the engine's own request logger, so each line already carries the `request_id`, `api_version`, `transport` and `template`; the lines go to the same stream as the engine's and respect `LOG_LEVEL`.

```ts
logger.warn({ event: "mailjot.transport.mailjet.rejected", http_status: res.status, error_codes: codes, duration_ms }, "Mailjet did not accept the message");
```

- **Name events `mailjot.transport.<id>.<what>`** and put the data in fields, not in the sentence.
- **Log what happened and how it went**: an HTTP status, an error code, a duration, a count. That is what lets an operator see *why* a send failed, since the engine's `mailjot.send.failed` line deliberately carries only the transport, template and reason.
- **Never log the message or the provider's words.** Not the `subject`, `html`, `text` or `envelope`, not the values in `options`, not anything from `config`, and not a provider's response body or error text: a refusal such as "alice@example.com is invalid" echoes a recipient. Log the provider's error *codes*, which do not. The caller already receives your result's `message` and `response`.
- **Log the kind of a network failure, not its text.** `err.name` and the `cause.code` (`ECONNREFUSED`, a timeout) say enough; the error's message can contain the URL.
- **Use `console` only if printing is the transport's purpose**, as the `Logging` transport does. Anything else goes through `logger`.
- In a test, pass `captureLogger().logger` (from `test/captureLogger.ts`) as the message's `logger` and assert on the events and fields, and that nothing private appears in the captured output.

## Reading the sender's log

Each sender request produces its own lines plus one `mailjot.request` access line, all sharing a `request_id` (send one in `X-Request-Id`, or read it from the response header). What to watch:

| Event | Level | Means | Act when |
| --- | --- | --- | --- |
| `mailjot.auth.rejected` | warn | A sender request had no valid token. `credential_presented` says whether any `Authorization` header was sent; the token itself is never logged, nor the client address. | Many in a short time (probing, or a client with the wrong or no token). Alert on the rate. |
| `mailjot.sender.ready` | info, or warn | At startup. `auth: "disabled"` (a warning, with the reason) means every sender request will be rejected until a token of at least 16 characters is set. | `disabled` in an environment that should send. |
| `mailjot.send.failed` | error | A transport refused (`rejected`) or could not deliver (`unreachable`). | Any, and the rate. `rejected` is usually the message or the account; `unreachable` the provider or the network. The transport's own line for the same `request_id` (for example `mailjot.transport.mailjet.rejected` with `error_codes`) says why. |
| `mailjot.send.ok` | info | A message was handed to the transport. `dry_run: true` means nothing was sent. | Trend it: a fall in volume is as informative as a failure. |
| `mailjot.transport.unavailable` | warn / error | A transport is not configured (`problems` names the variables). | Any, after a deploy. |
| `mailjot.render.failed` | error | A template failed to build, or its output failed the integrity checks (`code`, `detail`). | Any: it is a template bug. |
| `mailjot.error.unhandled` | error | Something unexpected, with the cause. | Any. |

Mistakes by the caller (bad JSON, input that fails the template's schema, a bad envelope or options, an unknown template or transport) are not events of their own; they appear only as `mailjot.request` lines with a 4xx status.

## Rate limiting

Every accepted request can send a real email through your provider account, so limit the sender routes separately from rendering, at your proxy. See "Rate limiting / deployment guidance" in the [README](../README.md).
