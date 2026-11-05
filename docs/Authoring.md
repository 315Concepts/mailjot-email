# Authoring

A **template** is an email that is yet to be built: source with a schema, a component, a subject and examples. A **document** is what you get when a template is built from an input: the subject, HTML and plaintext. You author templates; the engine builds them into documents. The guiding principle of the project: **adding a template or a transport should not require modifying the engine.** (Transports are covered in [Sending.md](Sending.md).)

## Writing a template

A template is a directory inside a version directory under `templates/`; its path within the version is its identity (`templates/v1/billing/receipt` is `billing/receipt` at `/v1`). Start by copying `templates/v1/accounts/welcome` (minimal) or `templates/v1/billing/receipt` (dynamic subject, table, computed total).

```
templates/v1/<group>/<name>/
├── index.tsx           # the template module (see below)
├── schema.ts           # Zod schema for the input
└── <name>.stories.tsx  # Storybook story (see Storybook.md)
```

`index.tsx` must export:

| Export | What it is |
| --- | --- |
| `schema` | Zod schema. Use `z.strictObject` so unknown properties are rejected. |
| `metadata` | `{ id, version, description }`. `id` must equal the directory path. |
| `subject` | A string, or `(input) => string`. Must be a single line. |
| `default` | The React Email component. It receives the validated input. |
| `examples` | Named example inputs; at least one. Every example must pass the schema. |

Guidelines:

- **Derive the input type from the schema** with `z.infer<typeof schema>`. Do not use `.default()`, `.transform()` or other input/output-diverging schema features; the contract uses one type for both.
- **Build text in template strings** (`` {`Hello ${name}`} ``) rather than mixing literals and expressions, so the HTML is not split into separate text nodes.
- **Both outputs come from the same component.** Check the plaintext in Storybook. For data tables add `data-text-format="dataTable"` to the `<table>` so the plaintext stays aligned.
- **Never emit unresolved values.** A document containing `undefined`, `NaN`, `[object Object]` or `{{ }}` is rejected as a render failure.
- **Money in minor units** (integers), formatted with `Intl.NumberFormat`.
- **Use neutral, fictional example data** (names like Alice, order numbers like ORD-1001). No real people, addresses or companies.
- **Keep templates browser-safe.** They are bundled into Storybook, so no Node-only APIs.
- **Bump `metadata.version`** when the schema or the document it builds changes in a way consumers would notice. It is semver, and its major number must equal the version directory's (`v1` templates are `1.x.y`).
- **Never make a breaking change to a released version.** Create a new version directory instead (see "Adding an API version").

A new template is picked up automatically by the API, Storybook, and the contract test (`engine/contract.test.ts`), which builds every example into a document and checks the integrity rules. Template-specific logic can have its own `*.test.ts` next to the template (see `templates/v1/billing/receipt/receipt.test.ts`).

Deliberately broken templates for testing the engine go in `test/fixtures/templates/v1/`, never in `templates/`.

### Using Tailwind

Templates can style themselves with Tailwind utility classes. React Email's `Tailwind` component turns them into inline styles at build time, plus a small `<style>` block for media queries; it ships with `react-email`, so there is nothing to install. `templates/v1/demos/tailwind` is the reference: brand colours, a logo, a styled button, a features list and a responsive padding rule.

- **Wrap `<Html>` in `<Tailwind>`**, not the other way round, so the component can put responsive rules in `<Head>`. Keep `<Head />` inside it.
- **Pass the config per template** (`presets: [pixelBasedPreset]` plus `theme.extend`). There is no shared Tailwind config in the engine; brand tokens are repeated in each template that uses them.
- **Use `pixelBasedPreset`**, which converts spacing and font sizes to pixels. Many mail clients handle `rem` inconsistently.
- **Pin what the preset leaves in `rem`/`em`.** It does not cover border radius, max width (`max-w-*`, which also drives `w-md` and similar) or letter spacing (`tracking-*`). Set the ones you use under `theme.extend` in the template's config, for example `borderRadius: { lg: "8px" }`, `maxWidth: { xl: "576px" }`, `letterSpacing: { wide: "0.4px" }`. The demo's test fails if `rem` or `em` reaches an inline style. Media queries such as `sm:` use `rem` in the `<style>` block, which is fine.
- **Lay out with table-based components** (`Section`, `Row`, `Column`) rather than `flex` or `grid`, which many clients ignore. Avoid CSS variables and modern colour functions for the same reason.
- **Images need an absolute `https` URL.** A template cannot read files at render time, and `data:` images are blocked by Gmail and Outlook, so take the image URL as an input (the demo's `logoUrl` is validated as `https`). Use a format your target clients show; `.ico` support in particular is patchy.
- **Check the plaintext.** It is built from the same component. Headings are uppercased in it, and images and styling do not appear.
- **Add a small test for what is specific to Tailwind:** that a utility became an inline style, that a responsive class produced an `@media` rule, and that no `rem`/`em` reached an inline style (see `templates/v1/demos/tailwind/tailwind.test.ts`).
- Outlook on Windows ignores `border-radius` whatever the unit, so rounded corners will not appear there.

## Templates for external systems

A template does not have to be sent by mailjot. For systems that render their own templates (Ory Kratos), mailjot can be where the email is designed and previewed, with the finished document converted into the other system's syntax afterwards. See [templates/v1/ory/pipeline.md](../templates/v1/ory/pipeline.md).

## Adding an API version

A version is a directory (`templates/v2/`) plus code. Copy the templates that `v2` should serve into it (there is no fallthrough to `v1`), add `engine/routers/v2/` (copy the `engine/routers/v1/` bundle: its `router.ts` default-exports the router factory, alongside the version's envelope, sender and transport contract). Bundles are discovered from that layout, so there is nothing to register. The engine refuses to start if a templates version directory has no router implementation. Keep `v1` unchanged: its request and response shapes are frozen once released.

## Reporting problems

Include the template, the request payload (with anything sensitive removed), the response, and the engine's log output for a 500.
