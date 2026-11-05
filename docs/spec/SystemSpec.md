# Email Rendering Engine — Technical Specification

Proposed

v0.2 (draft)

Objective: A containerized, filesystem-driven email rendering service. Templates are independently authored, validated, built into documents, discoverable, and previewable.

Guiding principle: Adding a template must never require modifying the rendering engine. The same holds for delivery: adding a transport must never require modifying the engine.

## Terminology

- A **template** is an email that is yet to be built: source consisting of a Zod schema for its input, a React Email component, a subject and examples. Templates are authored, versioned and compiled.
- A **document** is a template that has been built: the subject, HTML and plaintext produced by rendering a template with an input. Documents are what the render route returns and what transports deliver.
- A **message** is a document together with its envelope (sender and recipients), which is what a transport receives.
- Building a template means rendering it with an input. It is unrelated to the build step that compiles the code.

## 1. Technology stack

| Component            | Technology           |
| -------------------- | -------------------- |
| Runtime              | Node.js / TypeScript |
| HTTP API             | Express              |
| Template authoring   | React Email          |
| Validation           | Zod                  |
| Schema serialization | Zod `toJSONSchema()` |
| HTML rendering       | React Email renderer |
| Plaintext rendering  | React Email renderer |
| Development preview  | Storybook            |
| Test fixtures        | Faker.js             |
| Deployment           | Docker               |
| Delivery (optional)  | Pluggable transports |

## 2. Template architecture

Templates are filesystem-native packages.

```
templates/
└── v1/
    ├── accounts/
    │   ├── welcome/
    │   └── password-reset/
    ├── billing/
    │   ├── receipt/
    │   └── subscription-expiring/
    └── devices/
        └── offline/
```

Each template implements a standardized interface:

```
template/
├── index.tsx       # Template entry point
├── schema.ts       # Zod input contract
├── fixtures.ts     # Preview and test data
└── *.stories.tsx   # Storybook stories
```

- Directory path within a version directory defines template identity (`templates/v1/accounts/welcome` is `accounts/welcome` in `v1`).
- Template entry point exports its contract and renderer.
- No central template registry.
- No manual API route registration.
- Template discovery is automatic.
- Templates are independently testable.

### Versioning

The API is versioned, and the version is defined by the directory layout.

- A version directory `v<N>` directly under `templates/` (and under `transports/`, section 9) defines version N. Its routes are served under `/v<N>/`.
- One version number covers the API shape and the templates and transports served under it.
- A released version's request and response shapes are stable. A breaking change creates a new version rather than editing an existing one.
- A version directory is a complete set. A version serves only what is inside its own directory; there is no fallthrough to an earlier version. Unchanged templates are copied or symlinked into the new version.
- The API shape of a version is implemented in code, in a matching bundle, `engine/routers/v<N>/`, whose `router.ts` default-exports the version's router factory and which also holds that version's envelope, sender and transport contract. Bundles are discovered from that layout; there is no central registry. A templates version directory with no router implementation is a startup error, not a silent 404.
- `metadata.version` is a semver string, and its major number must equal the directory's version (`v1` templates are `1.x.y`).
- Unknown versions return `404`.

## 3. Template contract

Each template must expose:

| Export     | Responsibility                          |
| ---------- | --------------------------------------- |
| `schema`   | Zod input validation                    |
| `metadata` | Template identity, version, description |
| `subject`  | Static or dynamic subject generator     |
| `default`  | React Email component                   |
| `examples` | Named example inputs                    |

The schema is the authoritative definition of a template's inputs.

TypeScript types are inferred using `z.infer<typeof schema>`.

Unknown input properties are rejected using strict object validation.

## 4. Rendering pipeline

HTTP request

Template discovery

Zod validation

React Email rendering

HTML + plaintext generation (the document)

Output integrity validation

Response

Requirements:

- Invalid inputs never reach rendering.
- Rendering failures never produce successful responses.
- Both output formats are mandatory.
- Subject generation is part of building the document.
- No partial or best-effort rendering.
- Output integrity checks prevent unresolved template expressions in the document.
- Rendering must be deterministic for identical template versions and inputs.

## 5. REST API

The service exposes a minimal REST interface.

| Method | Endpoint                             | Purpose                                        |
| ------ | ------------------------------------ | ---------------------------------------------- |
| GET    | `/`                                  | List mounted API versions                      |
| POST   | `/v1/render/{template}`              | Build a template into a document               |
| GET    | `/v1/schemas/{template}`             | Retrieve JSON Schema                           |
| GET    | `/v1/templates`                      | Discover available templates                   |
| POST   | `/v1/sender/{transport}/{template}`  | Build and send a document (section 9)         |
| GET    | `/v1/sender`                         | Discover available transports                  |

Example:

```
POST /v1/render/accounts/welcome
Content-Type: application/json
```

Successful response, the built document (its `template` and `version` fields identify the template it was built from):

```
{
  "template": "accounts/welcome",
  "version": "1.0.0",
  "subject": "Welcome aboard, Alice!",
  "html": "<!DOCTYPE html>...",
  "text": "Welcome aboard, Alice!"
}
```

Validation failure returns HTTP `422` with structured field-level errors.

Unknown templates return `404`.

Rendering failures return an appropriate `5xx`.

Delivery is optional and provided only by transports (section 9). With no transports installed, the sender routes answer `404` as unknown routes.

## 6. Schema discovery

Zod schemas are automatically serialized into JSON Schema.

`GET /v1/schemas/{template}` returns:

- Template identity.
- Template version.
- JSON Schema specification version.
- Generated JSON Schema.
- Template description.
- Example inputs.

JSON Schema is generated from the same Zod schema used for production validation.

No separately maintained API contract.

Runtime Zod validation remains authoritative where JSON Schema cannot express a custom validation rule.

## 7. Storybook development environment

Storybook automatically discovers template stories.

Each template must support:

- Default preview.
- Named fixture scenarios.
- Interactive input controls.
- Live HTML preview.
- Plaintext preview.
- Schema validation feedback.

The preview must show the actual built document, not an approximate browser representation of the template's React component.

Development fixtures are never production defaults.

## 8. Containerization and deployment

Two operating modes:

| Development                 | Production                |
| --------------------------- | ------------------------- |
| Mounted templates directory | Immutable template bundle |
| Hot reload                  | Cached module imports     |
| Storybook                   | Express API               |
| Runtime compilation         | Precompiled TSX           |
| Faker fixtures              | Explicit request inputs   |

Requirements:

- Templates and transports directories mounted read-only in production.
- Atomic template releases.
- No runtime dependency installation.
- No production TSX transpilation per request.
- Template versions remain consistent throughout a deployment.
- Engine, template and transport packages can be deployed independently.

## 9. Transports and delivery

Delivery providers are plugins. A transport is a directory under `transports/v<N>/` containing a `transport` module; the directory name is its identity.

```
transports/
└── v1/
    └── Mailjet/
        ├── transport.tsx
        └── transport.test.tsx
```

Each transport must expose:

| Export     | Responsibility                                                            |
| ---------- | ------------------------------------------------------------------------- |
| `metadata` | Transport identity and description; `id` matches the directory name       |
| `config`   | Zod schema for settings read from environment variables (keys, endpoints) |
| `options`  | Optional Zod schema for provider-specific extras; default is no options   |
| `default`  | `send(message)`, resolving to a result: success with the provider response, or a failure value (`rejected` or `unreachable`) |

The contract is provider-neutral. The engine owns one envelope (`from`, `to`, `cc`, `bcc`, `replyTo`) and validates it before any transport sees it, so callers can switch transports without changing their requests. A transport receives the built document's subject, HTML and plaintext, the validated envelope and options, and its parsed config, and translates them to its provider's API inside its own directory. Transports never throw engine errors and never import engine code at runtime; the contract is owned by the engine, one per API version (`engine/routers/v1/transport.ts`): its types are what transports import with `import type`, and its runtime check is used only by that version's router, so each version resolves its own transports and contract.

- Transports are discovered and mounted automatically. There is no registry and no manual route registration.
- Transport names are matched case-insensitively against the directory name; the directory name is canonical.
- Config is validated when the transport loads. A transport with missing or invalid config is listed as unavailable and returns `503`; the engine keeps running.
- With no transport files, the sender routes answer `404` as unknown routes, whatever credentials are sent. This is decided on every request, so a transport added while the server runs is available without a restart; changing a transport that has already loaded needs one.

### Sending

`POST /v1/sender/{transport}/{template}` takes `{ "envelope": { ... }, "options": { ... }, "input": { ... } }`. `input` is the template's input, unchanged; `envelope` is the engine's common envelope; `options` (optional) is validated by the transport's own `options` schema. The first path segment is the transport and the remainder is the template, so `/v1/sender/MailJet/accounts/welcome` builds `templates/v1/accounts/welcome` into a document and sends it with `transports/v1/Mailjet/transport.tsx`.

Success returns `200` with the transport name, the template's path and version (in the `template` and `version` fields), the subject, the provider's message id when it supplies one, and the transport's response passed through unchanged.

| Condition | Status | Body |
| --------- | ------ | ---- |
| Build-layer failure | `400` | Flat error, below |
| Invalid envelope or options | `400` | Flat error with `error: "invalid_envelope"` or `"invalid_options"` and `fields` |
| Unknown transport, template or version | `404` | Standard error |
| Provider rejected the send or was unreachable | `502` | Standard error; `details` carries the reason and the provider's response |
| Transport unavailable (config) | `503` | Standard error |

Build-layer failures return a flat body, not the nested error object used elsewhere:

```
{
  "error": "render_failed",
  "sub_error": "validation_failed",
  "description": "Input validation failed",
  "fields": [ { "path": ["name"], "code": "invalid_type", "message": "..." } ]
}
```

| `sub_error`         | Meaning                                            |
| ------------------- | -------------------------------------------------- |
| `validation_failed` | Input failed the template's schema; `fields` lists errors |
| `integrity_failed`  | The built document failed integrity checks; `description` names the check |
| `render_failed`     | The template's component threw; `description` is generic, internals are only logged |

Requirements:

- Nothing is sent unless the template builds fully and the envelope is valid.
- Building and delivery stay separate: transports receive the finished document (subject, HTML and plaintext) and never influence how it is built.
- Sender routes require a bearer token (`MAILJOT_TRANSPORT_AUTH_TOKEN`, at least 16 characters) and deny all requests, with `401`, when none is configured. Authentication happens before any other processing of the request.
- A dry-run mode (`"dryRun": true` in the body) builds and validates the document, envelope and options without calling `send`.
- Internal errors and provider credentials never appear in responses.

## 10. Explicitly out of scope

Initial release does not include:

- Delivery queues, retries, bounce handling or provider webhooks.
- Email campaign management.
- Contact management.
- Scheduling or queuing.
- Template database or administrative UI.
- WYSIWYG email editor.
- Runtime template authoring through API.
- Multi-tenant template permissions.
- PDF generation.

## 11. Definition of done

The initial release is complete when:

1. A developer can create a new template directory without modifying engine code.
2. The engine automatically discovers the new template.
3. Storybook automatically discovers and previews it.
4. Its Zod schema validates all incoming inputs.
5. Its JSON Schema is available through GET.
6. Valid POST requests build a document with HTML and plaintext.
7. Invalid POST requests never produce a successful document.
8. The production container runs compiled, immutable templates.
9. A version directory is mounted at `/v<N>` automatically, and a version directory with no router implementation fails startup.
10. A developer can add a transport file without modifying engine code, and it is discovered and mounted.
11. Sending never occurs when building the document or validating the envelope fails, and build-layer failures return the flat `400` body.
12. Unauthenticated sender requests are rejected.
