# External template pipeline: mailjot as a design studio

External systems will often send their own emails from static templates that it itself is responsible for rendering. Mailjot cannot sit in that path: the external system never calls it. This note explains why mailjot is still useful for those email systems, and how the files in this directory turn a mailjot template into something that an external templating system for the Ory auth project can still take advantage of.

## The idea

Some systems own their email templates and keep them in a silo: a different engine (Go `html/template` here), a different syntax and no preview tooling. Writing HTML by hand for them is slow and hard to review.

Mailjot is great at exactly the part they fail to solve - you write a React component with Tailwind, validate its input with a schema, preview the HTML and plaintext in Storybook, and see the _real document_. So treat mailjot as the **design studio** and the external system as the **runtime**:

1. Design and review the email in mailjot.
2. Build it once, with stand-in values where the external system will put real data.
3. Convert the stand-ins into the external system's own expressions.
4. Ship the resulting static files to that system. Mailjot is not involved after this.

The output is plain files, so the external system needs no knowledge of mailjot.

## An Ory specific pipeline example

```
templates/v1/ory/<key>/           1. author the template (React, Tailwind, schema, stories)
templates/v1/ory/<key>.json       2. request body, with ALL_CAPS stand-ins as the input values
templates/v1/ory/maketmpl         3. POST each body to the running server's Recording transport
templates/v1/ory/gotmpl           4. replace stand-ins with Go expressions, rename, move
recorded/ory/<key>/               5. Each template has `email.body.gotmpl`, `email.body.plaintext.gotmpl`, `email.subject.gotmpl`
```

Run it with the server up and `RECORDING_DIR=./recorded` set:

```
MAILJOT_TRANSPORT_AUTH_TOKEN=... templates/v1/ory/maketmpl
templates/v1/ory/gotmpl
```

Then mount the resulting files into the Kratos container and point its `courier.smtp.templates` config at them - fresh, modern emails for everyone.

## Why stand-ins

The engine _refuses to build_ a document containing `{{ }}` (see `engine/integrity.ts`). That rule catches unresolved variables in normal use, and it is _not worth weakening_ just for this kind of work. The template's schema takes plain strings as arguments (from `maketmpl`, here) and the request passes `SOME_VARIABLE_VALUE`, then a script (`gotmpl`, here) swaps it for the external system's template string `{{ .SomeVariableValue }}` after the document is built.

This keeps the engine untouched, which fits the project's rule that adding a template never changes the engine. The all-caps values are easy for people to read, and scripts replaces them mechanically.

## Rules for a new external template

- Every input is a string. Use an all-caps stand-in as the value in the payload.
- Request and record first, then transform and arrange in a separate step.

## What this does not do

- **One way only.** Mailjot is the source. Edit the template and regenerate; do not edit the generated pipeline files.
- **Substitution only.** The stand-ins stand for single values. Conditionals, loops and free-form objects such as `Identity` are not supported.
- **Manual QA.** Nothing checks that the output renders in Kratos. Send a real flow through it once or twice after a change. A stand-in missing from `VALUES` would appear as literal text in the email.
- **Outlook.** Go's `html/template` may strip the `<!--[if mso]>` comments around buttons, so Outlook's rendering is not guaranteed.

## Using the same approach for other systems

Nothing here is specific to Ory beyond `gotmpl` and the file names. Any system that loads a static template file can use the same pipeline: pick stand-ins, record through the Recording transport, and write a converter for that system's syntax and layout.
