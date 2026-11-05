# Implementation Part 4 — Structured logging

Status: **Complete.** Steps 1 to 7 are done; the audit after Step 6 is recorded under Step 6, and the closing checks under Step 7.

Goals:

1. **One operational log format**: JSON lines on stdout, with levels, a request ID on every line for a request, and one access line per request.
2. **Safe by default.** Logs are where internals go ("logged, never returned" in [CLAUDE.md](../../CLAUDE.md)), so credentials, request bodies, subjects and recipient addresses must not reach them.
3. **No change to any v1 request or response shape.** The transport contract gains one field, a `logger`, in place because `v1` is unreleased (Step 5).

## Where logging stood before this work

Historical: this is the starting point, not the current state. Every call below has been replaced (Steps 2, 3 and 5).

About 17 free-text `console.*` calls, no levels, no request IDs and no access log:

| Where | What it logs |
| --- | --- |
| `engine/index.ts` | `Fatal:` startup failures; the "listening" line |
| `engine/app.ts:74` | the final 500 handler: the raw error |
| `engine/versions.ts:26` | warning for a non-version directory (for example `templates/static`) |
| `engine/routers/v1/router.ts` | unloadable templates, sender auth and transport availability at startup, transport unavailable, and every error branch of `onError` |
| `engine/routers/v1/sender.ts:113` | render failure, with the error's `cause` |
| `transports/v1/*` | `Logging` (one JSON line per message, by design), `BlackHole`, `Recording` write failure |

The `Logging` transport is a delivery sink for development, not operational logging, and stays as it is.

## Constraints from the architecture

- **Render path is browser-safe.** `render.ts`, `integrity.ts`, `schema.ts`, `validation.ts`, `errors.ts` and `template.ts` run in Storybook and must not use `process`, `Buffer` or Node modules (`engine/browser-safe.test.ts`). They never log; the routers log what they throw.
- **The generic engine is version-agnostic.** The logger is created in `engine/` and given to each router through `VersionContext`, the way directories and the environment already are.
- **Transports `import type` only** from the engine and are compiled and mounted separately. They cannot import the logger, so the engine hands each transport one on the message it receives (see Step 5).
- **Released v1 shapes are frozen.** A request ID is a response *header*; no body changes.

## Step 0 — Decisions

Settle first. Bold is what this plan assumes.

- **Library: pino**, not a hand-rolled logger. Levels, child loggers, redaction and error serializers are what we would otherwise rebuild. One new production dependency, which `npm ci --omit=dev` already carries into the engine image.
- **Output: JSON lines on stdout**, for `docker logs`. No files, no transports for log shipping; the platform does that.
- **Recipients are not logged.** No addresses, no subject, no bodies, no request payloads. Validation failures log field paths and codes only.
- **Pretty printing is not built in.** For development, pipe the output through a formatter (documented in the README as `npm run dev --silent | jq`; plain `npm run dev` does not work with a formatter because npm prints its own banner lines to stdout).
- **The log format is an operational interface.** Replacing the free-text lines is a change for anyone grepping logs. At `0.1.0` (unreleased) that is acceptable; it still gets a CHANGELOG note.
- **Should the client address be logged on rejected auth?** - Decision = No
- **Log recipients as hashes?** Decision = No
- **Default level.** Decision = `info`

## Step 1 — The logger

New `engine/logger.ts` (Node-only; not in the browser-safe list):

- `createLogger({ env, destination? })` returns a pino logger. `destination` exists so tests capture output; production uses stdout.
- Level from `LOG_LEVEL` (`trace` to `silent`; default `info`; an invalid value falls back to `info` and says so once).
- Base fields: `service: "mailjot"`, `version` (from `package.json`). Timestamps ISO.
- **Redaction** (pino `redact`), applied to anything logged under `req`, `headers` or `err`: `authorization`, `cookie`, and any key matching the credential names the transports use (`*API_KEY*`, `*API_SECRET*`, `*TOKEN*`). A redaction list is a backstop; the rule remains "do not log these in the first place".
- **Error serializer**: `message`, `name`, `code`, `stack`, and the `cause` chain by message and stack only. Raw `cause` objects are not logged, because a provider error can carry a response body.
- Synchronous stdout destination, so a `Fatal:` line is written before `process.exit(1)`.

Done when: a unit test shows level filtering, redaction of an `authorization` header and an API-secret-named key, and the error serializer's output for an error with a `cause`.

Status: done (`engine/logger.ts`, `engine/logger.test.ts`). Two differences from the text above:

- **Redaction walks the logged object instead of using pino's `redact` paths.** Pino's paths match exact keys and wildcards for whole path segments, not substrings, so they cannot express "any key containing `TOKEN`". `redact()` replaces the value of any key matching `authorization|cookie|api[_-]?key|api[_-]?secret|secret|token|password|passwd` (case-insensitive) in plain objects and arrays, at any depth up to 8, without modifying the input and without failing on cycles. It applies to everything logged, not only `req`, `headers` and `err`. It does not look inside message strings or error messages, so credentials must still never be put in those.
- **`pino` was added to `dependencies` here, not in Step 7**, because the logger cannot be built or tested without it. Step 7 still covers the compose files and docs.

Also: `time` is an ISO string, `level` is a label (`"info"`, not `30`), and `pid` and `hostname` are left out (the platform adds those). The logger is not yet used by anything; Step 2 wires it in. An unknown `LOG_LEVEL` logs one `mailjot.log.level_invalid` warning and uses `info`.

Checked: 18 tests; deliberately disabling redaction, or the error serializer, makes the tests fail; the compiled `dist/engine/logger.js` writes correct lines to stdout and finds the package version from the `dist/` depth; `npm run typecheck` and the full suite (348 tests) pass.

## Step 2 — Hand the logger to the routers

- `engine/router.ts`: add `logger: Logger` to `VersionContext`. The type is imported with `import type`, so the contract file stays light.
- `engine/app.ts`: `AppOptions.logger?` (default `createLogger({ env })`); pass a child logger per version (`{ api_version: "v1" }`) into each router; replace the `console.error(err)` in the final handler.
- `engine/versions.ts`: `discoverVersions(root, logger?)`, logging the "Ignoring ..." warning at `warn`. Keep `console.warn` as the fallback when no logger is passed, so existing callers and tests still work.
- `engine/index.ts`: create the logger first; `Fatal:` and "listening" go through it (`listening` with `port` and `templates_dir` fields).

Done when: no `console.*` remains in the generic engine files (`engine/*.ts`, outside tests) except the no-logger fallback in `versions.ts`, and `VersionContext.logger` is covered by the existing two-version router test. The calls inside the v1 bundle (`engine/routers/v1/router.ts` and `sender.ts`) move in Step 3, so they are expressly not part of this step.

Status: done. Differences and details:

- **Fatal startup lines now go to stdout**, as one JSON line, with the rest of the log, where they used to go to stderr as free text. The startup test reads stdout. `docker logs` shows both streams, so operators lose nothing, but anything that watched stderr for `Fatal:` must change.
- **Events added:** `mailjot.startup.failed` (`reason: "templates_dir_unreadable"`, `"invalid_layout"`, or an `err` for anything unexpected; an invalid layout is an operator message, so it carries no stack), `mailjot.listening` (`port`, `templates_dir`), `mailjot.versions.ignored` (`root`, `directory`) and `mailjot.error.unhandled` (the final 500 handler; the `err` serializer logs the cause, the response stays the generic 500).
- **`VersionContext.logger` is required**, so a router factory cannot be built without one. The v1 router receives it but does not use it until Step 3. Each router's logger is a child with `api_version` set.
- **`discoverVersions(root, logger?)`**: with a logger the warning is a structured `warn`; without one it is still `console.warn`, so `contract.test.ts` and scripts keep working.
- **`test/captureLogger.ts`** is a shared helper for tests: a real engine logger that collects lines in memory.
- This also means a `templates/static/` directory (such as the demo logo folder) now produces a structured `mailjot.versions.ignored` warning at startup in development; the compiled `dist/templates` does not contain it.

Checked: `npm run typecheck` and the full suite (352 tests) pass. Putting the final handler back on `console.error` fails a test. The compiled engine (`node dist/engine/index.js`) starts with the structured `mailjot.listening` line and serves `/healthz`; with a missing `TEMPLATES_DIR` and an invalid `LOG_LEVEL` it writes the warning and a `fatal` line and exits with status 1.

## Step 3 — Replace the router and sender logging

Convert each call to a levelled, structured event with a stable name:

| Today | Becomes |
| --- | --- |
| `Skipping unloadable template` | `warn` `mailjot.template.unloadable` with `template` and the serialized error |
| sender auth and transport startup lines | `info` `mailjot.sender.ready` (`auth: "required"` or `"disabled"`, plus the reason) and one `mailjot.transport.status` per transport |
| `Transport ... unavailable` | `warn` `mailjot.transport.unavailable` with `transport` and `problems` |
| `Send failed via ...` | `error` `mailjot.send.failed` with `transport`, `template`, `reason`; **not** the provider `response` |
| `Render failure ...` (router and `sender.ts`, currently duplicated) | `error` `mailjot.render.failed` with `template`, `code`, serialized error; logged once, in one place |
| contract and internal errors | `error` with the serialized error |
| *(new)* a successful send | `info` `mailjot.send.ok` with `transport`, `template`, `message_id`, `dry_run`, `duration_ms` |
| *(new)* failed sender authentication | `warn` `mailjot.auth.rejected` with the route and method; never the presented token, and no client address (Step 0 decision) |

`engine/auth.ts` stays free of logging; the rejection is logged by a thin wrapper in the router, so `bearerAuth` keeps its single job and its tests.

Done when: each branch of the v1 `onError` has a test asserting the event name and fields, and none of them contain `envelope`, `subject`, `html`, `text` or `response`.

Status: done. Where the build differs from the table above:

- **A failed render is logged once, by the router.** `sender.ts` no longer logs at all: it throws the flat 400 with the `RenderError` as its `cause`, and the router's error handler logs `mailjot.render.failed` for both `/render` and `/sender`. Its fields are `template`, `code`, `detail` (only when there is one, for example the integrity check that failed) and the serialized error with its cause chain.
- **`mailjot.send.failed` has no message or response.** The table says "not the provider `response`"; the transport's own `message` is left out too, because the Mailjet adapter builds it from the provider's `ErrorMessage`, which can echo a recipient address. The caller still receives it in the 502 body. The log has `transport`, `template` and `reason`.
- **`mailjot.auth.rejected` also records `method` and `credential_presented`** (whether an `Authorization` header was sent at all, never its value), because "a client sending nothing" and "a wrong token" are different problems for an operator. `bearerAuth` is unchanged; the router wraps it and logs when it did not call `next`. The order is kept: a missing transports directory still answers 404 first, then authentication, then anything else.
- **Startup is a `warn` when authentication is disabled** (`mailjot.sender.ready`, `auth: "disabled"`, with the reason), since every sender request will be rejected, and an `info` when it is required. Each transport is one `mailjot.transport.status` at `info` with `available` and, if unavailable, `problems`.
- **Separate events for separate causes:** `mailjot.transport.unavailable` (missing configuration; `warn` when listing, `error` when a request hits it), `mailjot.transport.contract_violation` and `mailjot.template.contract_violation` (a broken module, with `problems`), `mailjot.template.unloadable` (skipped in the listing, with `problems`), and `mailjot.error.unhandled` for anything unexpected.
- **Mistakes by the caller are not logged** (bad JSON, failed validation, bad envelope or options, unknown template or transport); Step 4's access line will record their status.
- Nothing in `engine/` calls `console` any more except the no-logger fallback in `versions.ts`.

Checked: `npm run typecheck` and the full suite (364 tests) pass. The tests that spied on `console.error` and `console.log` for engine output now read an injected logger; only the transports' own `console.log` output (`Logging`, `BlackHole`) is still spied. Three deliberate leaks were each caught by a test: logging the transport's message, logging the presented credential under a non-secret key, and logging the recipient on a successful send. The compiled engine now starts with only structured lines.

## Step 4 — Request ID and access log

New `engine/requestLog.ts`, mounted first in `createApp`:

- Take `X-Request-Id` if it is a short, safe string (`^[A-Za-z0-9._-]{1,64}$`); otherwise generate a UUID. Anything else is discarded, not echoed, so a caller cannot inject log content.
- Set `X-Request-Id` on the response, and attach `req.log` (a child logger carrying `request_id`).
- On `finish`, write one `mailjot.request` line at `info`: `method`, `route` (the matched route pattern, for example `/v1/render/*template`, not the raw path), `status`, `duration_ms`, `bytes_out`, and `template`/`transport` when known. Level `warn` for 4xx, `error` for 5xx.
- **Do not log the query string, headers or body.** Log the route pattern rather than the URL, so a template path with unexpected content never becomes a log key.
- `/healthz` is logged at `debug`, so a load balancer's probes do not drown the log.

Done when: tests show the header is set and echoed, a hostile `X-Request-Id` is replaced, and every line a request produces carries the same `request_id`.

Status: done (`engine/requestLog.ts`, `engine/requestLog.test.ts`). How it works, and where it differs from the text above:

- **`req.log` is the way to log inside a request.** `requestLog` mounts first in `createApp`; each version's mount adds a second step that scopes `req.log` to that version (`api_version`). The v1 router's handlers and error handler now log through `req.log`, so the Step 3 events (`mailjot.send.ok`, `mailjot.render.failed`, `mailjot.auth.rejected` and the rest) carry the `request_id`. The logger the router received at startup is used only for startup lines and as a fallback if a router is mounted without the middleware. Any future router should do the same.
- **The route comes from the matched pattern plus a fixed mount point**, for example `/v1/render/*template`. `req.baseUrl` is not used because it repeats whatever case the client typed (`/V1`), and `req.params` is already reset when the response finishes. The mount point is recorded by the engine, so the value is never client-controlled.
- **`template` and `transport` are added by the router once a name has resolved**, through `annotate(res, { ... })`, using the canonical ID. An unknown or hostile path therefore never reaches the log. Handlers that do not resolve a name (listing templates, listing transports) add nothing.
- **`(unmatched)`** is the route for a request no route handler answered: an unknown path, and also a request the sender's middleware answered itself (the 401, or the 404 when there are no transports). Use the `request_id` to find the matching `mailjot.auth.rejected` line. Everything else is as planned: `bytes_out` comes from `Content-Length` (left out when the response is chunked), `/healthz` is `debug` only while it succeeds, and the method is logged as `OTHER` if it is not a plain upper-case name.
- **`AppOptions.generateRequestId`** lets tests supply predictable IDs. Production uses `randomUUID()`.
- **Known gap: a client that disconnects before the response is finished is not logged**, because the line is written on `finish`, as the plan says. A long render that the caller abandons is therefore invisible in the access log. Handling `close` as well would fix it; it is left out of this step.
- Because 4xx responses are now logged at `warn` as access lines, two sender tests were tightened: "caller mistakes" now asserts that no *event* is logged and that the access lines show the expected statuses.

Checked: 25 new tests; `npm run typecheck` and the full suite (389 tests) pass. Three deliberate breakages were each caught: echoing any caller-supplied ID, logging the raw URL as the route, and a router writing a line through the startup logger instead of `req.log` (it lost the request ID). The compiled engine, started with a token and sent real requests, logged the expected access lines; a supplied ID was echoed, `bad id!` was replaced, the query string never appeared, and `/healthz` stayed out of the `info` log.

## Step 5 — Transports

Transports cannot use the engine logger, and they keep writing to `console`, which ends up on the same stdout. Giving them a logger means adding an optional `logger` to the message `send` receives. That is additive, but [CLAUDE.md](../../CLAUDE.md) treats a change to the `send` message as a contract change, so it usually belongs in a `v2` bundle but this is pre-release so we will just update `v1`.

Status: done (`v1` updated in place).

- **The contract.** `TransportMessage` in `engine/routers/v1/transport.ts` has a new `logger: TransportLogger` field. `TransportLogger` is a small interface of the engine's own (`debug`, `info`, `warn`, `error`, each taking a fields object and a short message), so a transport never depends on pino and still only `import type`s from the contract. The engine's real logger satisfies it. Its doc comment states the rules: log what happened and how it went, never the message (`subject`, `html`, `text`, `envelope`, option values), `config` credentials, or a provider's response or error text; name events `mailjot.transport.<id>.<what>`.
- **Scoped per message.** The sender passes `req.log` through `sendTemplate` and hands the transport `logger.child({ transport, template })`, so every line a transport writes already carries `request_id`, `api_version`, `transport` and `template`. A dry run never reaches a transport, so nothing is logged for one.
- **`logger` is required in the type, not optional**, which differs from this plan's earlier wording ("an optional `logger`"). The engine always supplies it, so a transport author never has to null-check, and a missing one can never silently drop logs. The cost is that every test that builds a message must pass a logger (`captureLogger().logger` from `test/captureLogger.ts`); the typechecker finds each one. This is the one thing to revisit if you would rather keep it optional. Existing compiled transports keep working at runtime because they simply ignore the extra property (not tested).
- **Built-in transports.**
  - `BlackHole`: its `Swallowed N characters on M lines!` is now `info` event `mailjot.transport.blackhole.swallowed` with `characters` and `lines`, and the message text is unchanged.
  - `Recording`: a write failure is `error` event `mailjot.transport.recording.write_failed` with the `directory` and the serialized error. It no longer goes to `console.error`.
  - `Mailjet` (new logging): `mailjot.transport.mailjet.sent` at `debug`; `.rejected` at `warn` with the HTTP status and Mailjet's `error_codes` (for example `mj-0013`) but never its error text; `.unreachable` with only the error kind and code, never the error text, which can name the host; `.non_json` with the status. Each has `duration_ms`. The engine's own `send.failed` line deliberately has no detail, so these lines are where an operator learns why Mailjet refused.
  - `Logging` is unchanged on purpose: it is a delivery sink whose job is to print the message, so it stays a plain `console.log` and bypasses the level filter and redaction. `LOG_LEVEL=silent` does not silence it.
- **Not yet done (Step 7).** `CLAUDE.md` still describes BlackHole's console line and the transport rules; `docs/Sending.md`'s "Writing a transport" should show `logger`.

Checked: `npm run typecheck`, the full suite (395 tests) and `npm run build` (transports compile against the new contract). The compiled engine, sent real requests through BlackHole and Logging, produced no non-JSON line except the `Logging` sink's own JSON, and BlackHole's line carried the request ID. Two deliberate breakages were caught: Mailjet logging the provider's error text, and the sender handing transports an unscoped logger.


## Step 6 — Tests

- Existing tests spy on `console.error` and `console.log` and assert on message text (about 20 sites in `engine/sender.test.ts`, 2 in `engine/versions.test.ts`). Move them to an injected capture stream; keep spies only where a transport itself calls `console` (the `Logging` transport's own output).
- **Canary test**: send through the sender with a known bearer token, a known recipient address, subject text and a provider secret in the environment, including a failing send and a render failure, and assert that none of those strings appear anywhere in the captured output. This is the test that catches a future leak.
- A test that `engine/logger.ts` is not imported by any file in the browser-safe list (extend `engine/browser-safe.test.ts`).
- No network, deterministic IDs (inject the ID generator), no real credentials.

Done when: `npm run typecheck` and `npm test` pass and the canary test fails if a redaction or a field is deliberately broken.

Status: done, with the audit below.

What exists against each item:

- **Console spies moved to an injected stream:** all of them, except where a transport itself calls `console` (the `Logging` sink in `engine/sender.test.ts` and `transports/v1/Logging/transport.test.tsx`), the no-logger fallback tests in `engine/versions.test.ts`, and a silencing spy in `engine/scripts.test.ts`. `engine/scripts.test.ts` and one app in `engine/app.test.ts` were building apps without an injected logger and printing 41 raw log lines into the test output; they now capture them, and a full `npm test` prints none.
- **Canary (`engine/canary.test.ts`):** the real startup, the real sender, the real built-in transports and the real `Mailjet` transport (only `fetch` is stubbed), with the bearer token, a Mailjet key and secret in the environment, a provider that echoes recipients, credentials and its own wording back in five kinds of failure (refused, unauthorised, down, unreachable, not JSON), a failed recording, render and integrity failures, bad requests carrying private values, and rejected authentication. The run produces 55 lines (the test requires more than 40), every one must be a JSON object, 14 specific events must have been logged (so the test cannot pass by logging nothing), and none of 17 forbidden values (secrets, the Basic-auth encoding, recipients, subject and body text, the provider's wording, a host name, an option value) may appear in the log, in the clear or base64-encoded.
- **Browser-safe guard (`engine/browser-safe.test.ts`):** none of the six render-path files may import `./logger`, `./requestLog` or `pino`, as a value or as a type. This was in the plan and had not been written.
- **Deterministic IDs:** `generateRequestId` is injected wherever IDs are asserted.

Audit, by deliberately breaking the logging and running the canary (each change restored afterwards):

| Deliberate leak | Canary |
| --- | --- |
| Mailjet logs the provider's error text | fails |
| `send.ok` logs the recipient | fails |
| `auth.rejected` logs the `Authorization` header under a non-secret key | fails |
| the access line logs the raw URL | fails |
| startup logs the sender token under a non-secret key | fails |
| `Recording` logs the caller's `tag` option | fails |
| the same token under a key named `token`, redaction on | passes (the backstop redacted it) |
| the `Authorization` header logged, redaction on / off | passes / fails |

So the canary catches a leaked field, and redaction demonstrably catches a leaked secret-named key. Logging all request headers fails the canary even with redaction on, because a header such as `X-Request-Id` is not secret-named; headers must never be logged wholesale.

Gaps found and closed in this pass: the package-version lookup (`findPackageVersion`, now exported and tested for the source depth, the `dist/` depth, a foreign `package.json`, bad JSON and a missing version); the router when mounted without the request log (it logs through its own logger, with no request ID, and does not fail); `bytes_out` left out of a streamed response; the `OTHER` method label (a real `M-SEARCH`); `X-Request-Id` on malformed-JSON and 500 responses; `LOG_LEVEL` end to end in a spawned engine (`warn` silences a healthy engine, `debug` adds the health check, `info` logs startup only); and Mailjet's branches (a thrown non-Error, a non-string code, a rejection with no error codes or no `Errors`, several codes, a success naming no recipient).

Coverage after this pass (`npm run coverage`): 421 tests, 99.55% statements and 98.35% branches overall, and every file above 90% on every measure. `logger.ts`, `requestLog.ts`, `app.ts`, `sender.ts` and the Mailjet transport are at 100% of statements, branches and lines. The one logging-related branch left is `templatePath`'s defensive non-array case in `router.ts` (97%); the other uncovered lines are in `integrity.ts`, `template.ts` and `transport.ts`, which this work did not touch.

Audit of the plan itself, fixed in this pass: the status line, goal 3 (the contract did change), three references to step numbers that your reordering had made stale, and the Step 5 statement that transports cannot log. Still true and worth knowing:

- **A client that disconnects before the response finishes is not logged** (Step 4).
- **Anything outside the request path still prints as plain text:** a crash or an unhandled rejection (Node prints the stack to stderr), and the `Logging` transport's own sink line. There is no log line for a shutdown signal.
- **`docs/Testing.md` is out of date** ("silence expected logs ... spy on `console.error`"); it belongs with Step 7.

## Step 7 — Packaging and docs

- `package.json`: add `pino` to `dependencies`. `Dockerfile`: nothing to change (prod dependencies are already installed in the engine image); check `npm ci --omit=dev` still resolves.
- `docker-compose.yml` and `docker-compose.dev.yml`: pass `LOG_LEVEL` through.
- [CLAUDE.md](../../CLAUDE.md): add `LOG_LEVEL` to the environment line, and a convention: use `req.log` or the injected logger, never `console`, in `engine/`; never log bodies, subjects, recipients or credentials.
- [README.md](../../README.md): a "Logging" section (format, `LOG_LEVEL`, the request ID header, how to pretty-print in development, what is never logged). [docs/Architecture.md](../Architecture.md): where the logger is created and passed. [docs/Sending.md](../Sending.md): the sender events and what to alert on (`mailjot.auth.rejected`, `mailjot.send.failed`).
- [CHANGELOG.md](../../CHANGELOG.md): under 0.1.0, "Structured JSON logging with request IDs"; note that the previous free-text lines are gone. A minor engine version bump if released after 0.1.0.

Done when: the docs describe the format and the privacy rules, and the CHANGELOG records it.

Status: done.

- **`pino`** is in `dependencies`, added in Step 1. The production image was built (`docker build --target engine`) and run: it contains pino 10.4.0 and no `tsx`, it starts as a non-root user on a read-only filesystem with the templates and transports mounted, and its output is structured (a supplied `X-Request-Id` was echoed on the health check at `LOG_LEVEL=debug`). With a missing `TEMPLATES_DIR` and `LOG_LEVEL=loud` it writes the warning and a `fatal` line and exits 1. The test image was removed afterwards.
- **Compose:** `LOG_LEVEL` is passed through in `docker-compose.yml` and `docker-compose.dev.yml` as an unset-by-default variable like the others (`docker compose config` shows `null`, or the shell's value when set).
- **`CLAUDE.md`:** `LOG_LEVEL` in the environment line; the BlackHole description corrected; the layout line mentions the logging modules; a transport rule (log through `message.logger`, events not content); a "Logging" convention (use `req.log`, never `console` in `engine/`, what is never logged, the canary, Node-only modules); and a testing convention (inject a logger and `generateRequestId`).
- **`README.md`:** `LOG_LEVEL` in the configuration line, and a "Logging" section: the format with a real example line, the request ID header, the event table, what is never logged, how to read the log in development (`npm run dev --silent | jq`; this was checked: without `--silent` npm's banner lines break a formatter), and what is not structured.
- **`docs/Architecture.md`:** the new modules in the component list, `index.ts` creating the logger, `logger` on `VersionContext`, and a "Logging" section with the scope chain (logger → `req.log` → version → router → transport) and the rules the design depends on.
- **`docs/Sending.md`:** the `Logging` transport's note that it bypasses `LOG_LEVEL`; BlackHole's line corrected; `logger` in "Writing a transport"; a "Logging from a transport" section; and "Reading the sender's log", a table of what each event means and when to act.
- **`docs/Testing.md`:** the console-spy advice replaced by injecting a logger, the new test files and the `captureLogger` helper in the layout table, and the canary rule.
- **`CHANGELOG.md`:** a bullet under Added and a "Logging" section under 0.1.0 (it is unreleased, so there is no version bump): the format, the request ID, what is never logged, the transport contract change, the fatal-line move from stderr to stdout, and the known gaps.

## Out of scope

- Metrics and tracing (OpenTelemetry). The request ID leaves room for it.
- Log shipping, rotation and retention: the platform's job.
- Sampling and rate-limiting log lines.
- Logging a request that the caller abandons before the response finishes, and structured output for process crashes (known gaps, see Step 6).
