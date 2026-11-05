# Implementation Part 1 — Core Build

Goal: get the major parts working end to end (engine, template runtime, validation/schema API, Storybook, container). Refer to [SystemSpec.md](SystemSpec.md) for requirements. Hardening and release work is in [Implementation-Part2.md](Implementation-Part2.md).

Each step ends in something runnable. Do them in order.

Note: this part is complete and describes the original flat layout. Terminology follows the current vocabulary: a **template** is an email that is yet to be built, and a **document** is a template that has been built (subject, HTML and plaintext). Paths are as originally built, when the templates directory was still named `documents/` (`documents/<group>/<name>`) and the engine source was in `src/`. [Implementation-Part3.md](Implementation-Part3.md) moved the templates to `templates/v1/`, renamed `src/` to `engine/` and added `engine/routers/`.

## Step 0 — Init workspace

- `package.json` with TypeScript, Express, React Email (the `react-email` package), Zod, Storybook, Faker, a test runner (Vitest), and tsx for dev.
- `tsconfig.json` (strict, JSX enabled), with separate build outputs for `src/` (engine) and the templates directory.
- Scripts: `dev`, `build`, `start`, `test`, `storybook`.
- Layout:
  ```
  src/            # engine
  documents/      # template packages (now templates/)
  ```
- Add one trivial sample template (`accounts/welcome`, now `templates/v1/accounts/welcome`) so every later step has something to run against.

Done when: `npm run build` and `npm test` pass on an empty-ish project.

## Step 1 — Template contract and discovery (F02)

- Define the template interface in one shared types file: `schema`, `metadata`, `subject`, `default`, `examples`.
- Discover templates by scanning the templates directory for directories containing `index.tsx`. The directory path is the template ID.
- Loader imports each module, checks it against the contract, and caches it.
- Resolve API paths to template IDs safely (reject `..`, absolute paths, unknown IDs).
- Fill out the `accounts/welcome` sample as the reference template.

Done when: a unit test discovers the sample template and rejects a malformed one.

## Step 2 — Render pipeline (F01)

- Render function: validate input, build the subject, render HTML and plaintext from the same component (together, the document), run integrity checks.
- Integrity checks reject empty output, an empty subject, and unresolved template expressions (e.g. `{{ }}`, `undefined`).
- Structured internal errors. Nothing internal leaks to callers.
- No partial or best-effort output; any failure is a failure.

Done when: building the sample template returns a document with HTML, text and subject, and each failure mode has a test.

## Step 3 — Validation and schema discovery (F03)

- Strict Zod validation before rendering; unknown properties rejected.
- Convert Zod errors to a stable field-level error shape.
- `toJSONSchema()` serialization, bundled with identity, version, description and examples.

Done when: bad inputs give structured errors, and the schema output for the sample is correct.

## Step 4 — REST API (F01, F03)

- Express app with `POST /v1/render/{template}`, `GET /v1/schemas/{template}`, `GET /v1/templates`.
- Status mapping: 422 validation, 404 unknown template, 5xx render failure.
- Template paths may be nested, so use a wildcard route, with the path resolved through Step 1.
- Add a `/healthz` endpoint for the container.

Done when: all three endpoints work via curl against the sample template.

## Step 5 — Storybook (F04)

- Auto-discover the templates' `*.stories.tsx` files.
- A shared story helper that takes a template module and builds the stories from its `examples`, so authors write minimal story files.
- Preview panel shows the real built document, HTML and plaintext (via the engine's render function), plus schema validation feedback.
- Faker-based fixtures for development only.

Done when: the sample template previews in Storybook, with HTML, plaintext and named scenarios.

## Step 6 — Container (F06)

- Multi-stage Dockerfile: build engine, precompile templates to JS.
- Dev compose: templates mounted, hot reload, Storybook.
- Prod image: engine only, compiled templates mounted read-only, no runtime installs or TSX transpilation.

Done when: the prod container serves the sample template from a mounted compiled bundle.

## Step 7 — Second template and "no engine changes" check

- Add a second template in a different folder (e.g. `billing/receipt`) with a dynamic subject and a more complex schema.
- It must work in API and Storybook without touching `src/`.

Done when: that is true. This proves the guiding principle.
