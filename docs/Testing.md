# Testing

Tests use [Vitest](https://vitest.dev). Run them with:

```
npm test            # run everything once
npm run coverage    # run everything once and write a coverage report
npm run typecheck   # tests are typechecked too
npx vitest          # watch mode
npx vitest run engine/render.test.ts   # one file
```

`npm run coverage` prints a table in the terminal and writes a browsable report to `coverage/index.html` (plus `coverage/coverage-summary.json` for tooling). It measures the code that ships: `engine/`, `transports/` and `templates/`, excluding tests and Storybook stories (see `vitest.config.ts`). The directory is git-ignored. There is no minimum threshold, so it never fails a run. `engine/index.ts` (the process entry point) is excluded: its test starts it as a separate process, which in-process coverage cannot see, so it would always read 0%. It is still tested (`engine/index.test.ts`), just not measured. Coverage also says which lines ran, not whether the tests checked the right things.

Run both `npm test` and `npm run typecheck` before finishing a change. Vitest does not typecheck, so a passing test run can still hide type errors.

## Layout

| Location | Contents |
| --- | --- |
| `engine/*.test.ts` | Engine tests, next to the module they cover. `engine/canary.test.ts` is the logging leak test (see below); `engine/logger.test.ts` and `engine/requestLog.test.ts` cover the logger and the request log. |
| `test/captureLogger.ts` | A real engine logger whose lines are collected in memory. Pass it as `createApp`'s `logger`, or as a transport message's `logger`. |
| `test/fixtures/templates/v1/` | Deliberately bad templates, one per failure mode: `broken` (the component throws), `leaky` (the document it builds fails the integrity checks), `hung` (rendering never finishes), `malformed` (violates the template contract, so it cannot be loaded) and `explosive` (validating its input throws an unexpected error). Used as an alternate templates root, mounted only at test time and never built to `dist`. |
| `test/fixtures/scripts/` | Request bodies for testing `scripts/sender` and `scripts/render`. |
| `test/fixtures/transports/v1/` | Test transports (in-memory, failing, unconfigured, broken). The real `Logging` and `Recording` transports live in `transports/v1/`; the in-memory fixture is deliberately named differently. Used as an alternate transports root, never built or mounted for real. `test/fixtures/transports-throwing/` holds one that violates the contract by throwing. |
| `transports/v<N>/<Name>/transport.test.tsx` | A transport's own tests, next to it, with the provider's HTTP calls mocked. |
| `templates/v<N>/` | Real templates, one directory per API version. Never put test-only templates here. |

Test files are excluded from the engine build.

## Guidelines

- **Test the behaviour the spec promises**, not the implementation. Good targets: invalid input never renders, failures never return a success, output is deterministic, nothing internal leaks to callers.
- **Every failure mode gets its own test.** If the engine rejects something on purpose, there should be a test that triggers it and checks the specific error code or status.
- **Prefer synthetic templates for edge cases.** Build a small template object in the test (see `makeTemplate` in `engine/render.test.ts`) instead of adding files. Use `test/fixtures/templates/v1/` only when the case needs a real file on disk, such as the loader or the HTTP layer.
- **Use temporary directories for filesystem cases** (`mkdtemp` under the OS temp dir, cleaned up in `afterAll`). Do not write into the repo during tests.
- **Test the API over real HTTP.** `engine/app.test.ts` starts the app on port 0 and calls it with `fetch`. Do not mock Express.
- **Assert on error shapes, not messages.** Check status codes, `error.code` and field paths. Message wording can change.
- **For error responses, also check what is absent.** Assert that internal messages, paths and stack traces do not appear in the body.
- **Inject a logger; do not spy on `console`.** The engine logs through an injected logger. Use `captureLogger()` from `test/captureLogger.ts`, pass `logger` to `createApp`, call `reset()` before the action, and assert on `lines()`: the `event`, the `level` and the fields (and that private values are absent from `raw()`). An app built without a logger writes real JSON lines into the test output. Spy on `console` only where a transport itself prints (the `Logging` transport) or to test the no-logger fallback in `versions.ts`. Inject `generateRequestId` when a test asserts request IDs.
- **The canary must keep passing.** `engine/canary.test.ts` sends secrets, recipient addresses, subjects and a provider that echoes them back through the real sender and transports, and fails if any of it appears in the log. If it fails after you add or change a log line, the line leaks: remove the field. Do not remove the value from the test's list.
- **No network, no clock, no randomness.** Tests must be deterministic. Faker is for development fixtures and Storybook, not for test assertions unless it is seeded.
- **Keep tests independent.** No shared mutable state between tests; each test creates what it needs.

## Adding tests for a new template

A new transport is covered by the contract test, which checks every real transport in every version (exports, `metadata.id`, config variable names, and that `options` accepts `{}`); write its own tests for the provider mapping.

A new template needs no engine tests. It is covered by the contract test (`engine/contract.test.ts`), which runs over every discovered template in every version directory of `templates/` (fixtures are excluded) and builds each example into a document, including a determinism check:

- All required exports are present and `metadata.id` matches the directory.
- Every entry in `examples` passes the template's schema.
- Every example builds into a document that passes the integrity checks.

Template-specific logic (a dynamic subject, conditional sections) can have its own `*.test.ts` file inside the template directory.
