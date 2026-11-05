import type { ComponentType } from "react";
import { z } from "zod";

export interface TemplateMetadata {
  id: string;
  version: string;
  description: string;
}

export type SubjectGenerator<T> = string | ((input: T) => string);

/** The contract every template's index module must satisfy. */
export interface TemplateModule<T = unknown> {
  schema: z.ZodType<T>;
  metadata: TemplateMetadata;
  subject: SubjectGenerator<T>;
  default: ComponentType<T & object>;
  examples: Record<string, T>;
}

export class TemplateContractError extends Error {
  constructor(
    public readonly templateId: string,
    public readonly problems: string[],
  ) {
    super(`Template "${templateId}" violates the contract: ${problems.join("; ")}`);
    this.name = "TemplateContractError";
  }
}

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

const SEMVER = /^(\d+)\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

/**
 * Checks a loaded module against the contract; throws TemplateContractError listing every problem.
 * With `majorVersion`, `metadata.version` must also belong to that major version (the directory's).
 */
export function assertTemplateModule(id: string, mod: Record<string, unknown>, majorVersion?: number): TemplateModule {
  const problems: string[] = [];

  if (!(mod.schema instanceof z.ZodType)) problems.push("`schema` must be a Zod schema");

  const meta = mod.metadata as Partial<TemplateMetadata> | undefined;
  if (typeof meta !== "object" || meta === null) {
    problems.push("`metadata` must be an object");
  } else {
    for (const key of ["id", "version", "description"] as const) {
      if (!isNonEmptyString(meta[key])) problems.push(`\`metadata.${key}\` must be a non-empty string`);
    }
    if (isNonEmptyString(meta.version)) {
      const match = SEMVER.exec(meta.version);
      if (!match) {
        problems.push(`\`metadata.version\` ("${meta.version}") must be a semver string like 1.0.0`);
      } else if (majorVersion !== undefined && Number(match[1]) !== majorVersion) {
        problems.push(`\`metadata.version\` ("${meta.version}") must have major version ${majorVersion} to match its v${majorVersion} directory`);
      }
    }
    if (isNonEmptyString(meta.id) && meta.id !== id) {
      problems.push(`\`metadata.id\` ("${meta.id}") must match the directory path ("${id}")`);
    }
  }

  if (typeof mod.subject !== "function" && !isNonEmptyString(mod.subject)) {
    problems.push("`subject` must be a non-empty string or a function");
  }
  if (typeof mod.default !== "function") problems.push("`default` must be a React component");

  const examples = mod.examples;
  if (typeof examples !== "object" || examples === null || Array.isArray(examples)) {
    problems.push("`examples` must be an object of named payloads");
  } else if (Object.keys(examples).length === 0) {
    problems.push("`examples` must contain at least one payload");
  }

  if (problems.length > 0) throw new TemplateContractError(id, problems);
  return mod as unknown as TemplateModule;
}
