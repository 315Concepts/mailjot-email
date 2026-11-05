import { z } from "zod";
import type { TemplateModule } from "./template.js";

export const JSON_SCHEMA_VERSION = "https://json-schema.org/draft/2020-12/schema";

export interface SchemaDescription {
  template: string;
  version: string;
  description: string;
  jsonSchemaVersion: string;
  jsonSchema: Record<string, unknown>;
  examples: Record<string, unknown>;
}

/**
 * Serializes the template's own Zod schema, so the published contract cannot drift from validation.
 * Describes the input side; constructs JSON Schema cannot express (refinements, transforms) are
 * left to runtime validation.
 */
export function describeSchema(template: TemplateModule): SchemaDescription {
  const { id, version, description } = template.metadata;
  const jsonSchema = z.toJSONSchema(template.schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;

  return {
    template: id,
    version,
    description,
    jsonSchemaVersion: JSON_SCHEMA_VERSION,
    jsonSchema,
    examples: template.examples,
  };
}
