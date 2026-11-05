import { render as renderEmail } from "react-email";
import { createElement } from "react";
import type { TemplateModule } from "./template.js";
import { RenderError, ValidationError } from "./errors.js";
import { checkIntegrity } from "./integrity.js";

export interface RenderResult {
  template: string;
  version: string;
  subject: string;
  html: string;
  text: string;
}

// This module also runs in the browser (Storybook previews call renderTemplate), so it must not touch
// `process`, `Buffer` or any Node-only API. Anything read from the environment is passed in by the caller.
export const DEFAULT_RENDER_TIMEOUT_MS = 10_000;

export interface RenderOptions {
  /** Bounds async rendering. Defaults to DEFAULT_RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Parses a timeout setting such as `RENDER_TIMEOUT_MS`; anything that is not a positive number means "use the default". */
export function parseRenderTimeout(value: string | undefined): number | undefined {
  const ms = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : undefined;
}

/** Bounds async rendering (e.g. a hung data fetch); it cannot interrupt synchronous CPU-bound code. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`render timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Validates `input`, then builds the template into a document: subject, HTML and plaintext.
 * Throws ValidationError for bad input and RenderError for anything that goes wrong afterwards.
 * Never returns partial output.
 */
export async function renderTemplate(template: TemplateModule, input: unknown, options: RenderOptions = {}): Promise<RenderResult> {
  const { id, version } = template.metadata;

  const parsed = template.schema.safeParse(input);
  if (!parsed.success) throw new ValidationError(id, parsed.error.issues);
  const data = parsed.data;

  let subject: string;
  let html: string;
  let text: string;
  try {
    subject = typeof template.subject === "function" ? template.subject(data) : template.subject;
    const element = createElement(template.default, data as object);
    [html, text] = await withTimeout(
      Promise.all([renderEmail(element), renderEmail(element, { plainText: true })]),
      options.timeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS,
    );
  } catch (cause) {
    throw new RenderError("render_failed", id, undefined, { cause });
  }

  if (typeof subject !== "string") {
    throw new RenderError("integrity_failed", id, "subject is not a string");
  }
  const problems = checkIntegrity({ subject, html, text });
  if (problems.length > 0) throw new RenderError("integrity_failed", id, problems.join("; "));

  return { template: id, version, subject, html, text };
}
