import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as welcome from "../templates/v1/accounts/welcome/index.js";
import type { TemplateModule } from "./template.js";
import { describeSchema, JSON_SCHEMA_VERSION } from "./schema.js";
import { formatIssues } from "./validation.js";

const welcomeTemplate = welcome as unknown as TemplateModule;

const errorsFor = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  if (result.success) throw new Error("expected validation to fail");
  return formatIssues(result.error.issues);
};

describe("formatIssues", () => {
  const schema = z.strictObject({
    name: z.string().min(1),
    items: z.array(z.strictObject({ qty: z.number() })),
  });

  it("reports missing and wrong-typed fields with paths", () => {
    expect(errorsFor(schema, { name: 5 })).toEqual([
      { path: ["name"], code: "invalid_type", message: expect.any(String) },
      { path: ["items"], code: "invalid_type", message: expect.any(String) },
    ]);
  });

  it("reports nested array paths with numeric indexes", () => {
    const errors = errorsFor(schema, { name: "a", items: [{ qty: 1 }, { qty: "x" }] });
    expect(errors).toEqual([{ path: ["items", 1, "qty"], code: "invalid_type", message: expect.any(String) }]);
  });

  it("reports each unknown property separately", () => {
    const errors = errorsFor(schema, { name: "a", items: [], foo: 1, bar: 2 });
    expect(errors.map((e) => e.path)).toEqual([["foo"], ["bar"]]);
    expect(errors.every((e) => e.code === "unrecognized_keys")).toBe(true);
  });

  it("reports a non-object payload at the root", () => {
    expect(errorsFor(schema, "nope")).toEqual([{ path: [], code: "invalid_type", message: expect.any(String) }]);
  });
});

describe("describeSchema", () => {
  it("describes the sample template", () => {
    const d = describeSchema(welcomeTemplate);
    expect(d).toMatchObject({
      template: "accounts/welcome",
      version: "1.0.0",
      description: "Welcome email sent to new accounts.",
      jsonSchemaVersion: JSON_SCHEMA_VERSION,
      examples: { default: { name: "Alice" } },
    });
    expect(d.jsonSchema).toMatchObject({
      $schema: JSON_SCHEMA_VERSION,
      type: "object",
      properties: { name: { type: "string", minLength: 1 } },
      required: ["name"],
      additionalProperties: false,
    });
  });

  it("does not throw on constructs JSON Schema cannot express", () => {
    const template = {
      ...welcomeTemplate,
      schema: z.object({ n: z.string().transform((s) => s.length) }).refine(() => true),
    } as TemplateModule;
    expect(() => describeSchema(template)).not.toThrow();
  });
});
