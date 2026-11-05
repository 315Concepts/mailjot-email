# Storybook

Storybook is the development environment for new and updated templates. It builds each template into a document through the engine's own `renderTemplate` function, so what you see is the real email artifact (HTML and plaintext), not an approximation of the React component.

```
npm run storybook         # dev server on http://localhost:6006
npm run build-storybook   # static build into storybook-static/
```

## What you get for each template

- A **scenario** selector built from the template's `examples`.
- An editable **input** control (JSON). Editing it overrides the scenario.
- A status badge: `valid`, `invalid input` or `render failed`.
- When the input is invalid, the field errors (path, message, code) exactly as the API would return them in a 422.
- When building the document fails, the error code and detail. The detail is shown here for debugging; the API never returns it.
- Tabs for the built document's **HTML** (in an iframe) and **Plaintext**, and for the template's generated **Schema**.

## Adding stories for a new template

Create `<template>/<name>.stories.tsx` next to the template's `index.tsx`:

```tsx
import { templateStories } from "../../../../storybook/templateStories.js";
import * as doc from "./index.js";

const stories = templateStories(doc);

export default { ...stories.meta };
export const Preview = stories.Preview;
```

The relative path to `storybook/` is four levels up from `templates/v1/<group>/<name>/`; adjust it if your template sits deeper. Storybook picks the file up automatically; no registration is needed. The story title includes the version (for example `v1/accounts/welcome`). It comes from both the file path and `metadata`, which must agree, so keep the story file inside its template's directory.

### Random data for development

Pass a generator to add a `random` scenario and a "Regenerate" button. Use Faker here, not in `examples`:

```tsx
import { faker } from "@faker-js/faker";

const stories = templateStories(doc, {
  random: () => ({ name: faker.person.firstName() }),
});
```

Faker data is for previews only - it must never become production data.

## How it is wired

| File | Role |
| --- | --- |
| `.storybook/main.ts` | Finds `templates/**/*.stories.tsx`. |
| `.storybook/preview.ts` | Global parameters. |
| `storybook/templateStories.tsx` | Builds the meta and the single `Preview` story from a template module. |
| `storybook/TemplatePreview.tsx` | The preview panel; builds the document with `renderTemplate` and shows it. |

Stories and the `storybook/` directory are not part of the engine or templates build, so they never reach `dist` or the production image.

## Gotchas

- **Keep the story file's exports statically readable.** Storybook indexes stories by parsing the file without running it. That is why the file uses `export default { ...stories.meta }` and `export const Preview = ...` rather than re-exporting or destructuring.
- **One story file per template.** Scenarios are a select control, not separate sidebar entries. Per-example stories would need a custom indexer.
- **The engine render path runs in the browser.** Anything it imports must work without Node APIs. Do not add `fs`, `path`, or Node globals such as `process` and `Buffer`, to `engine/render.ts`, `engine/integrity.ts`, `engine/schema.ts`, `engine/validation.ts`, `engine/errors.ts` or `engine/template.ts`.
- **`storybook build` is not a sufficient check.** The static build substitutes `process.env.*` references, so a stray one passes there and fails in `storybook dev` with `process is not defined`. `engine/browser-safe.test.ts` scans those files for Node-only globals and modules and runs with `npm test`; add any new browser-side engine file to its list. Configuration values the render path needs (such as `RENDER_TIMEOUT_MS`) are read by the Node-side router and passed in as an option.
- **Templates must be browser-safe too.** Their `index.tsx`, `schema.ts` and `fixtures.ts` are bundled for the preview.
