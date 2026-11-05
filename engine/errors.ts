import type { z } from "zod";

/** The payload did not satisfy the template's schema. Mapped to HTTP 422. */
export class ValidationError extends Error {
  constructor(
    public readonly templateId: string,
    public readonly issues: z.core.$ZodIssue[],
  ) {
    super(`Invalid input for template "${templateId}"`);
    this.name = "ValidationError";
  }
}

export type RenderErrorCode = "render_failed" | "integrity_failed";

/**
 * Rendering failed after the input was accepted. The message is safe to show callers;
 * implementation details live only in `cause` and `detail`, which must be logged, never returned.
 */
export class RenderError extends Error {
  constructor(
    public readonly code: RenderErrorCode,
    public readonly templateId: string,
    public readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(`Failed to render template "${templateId}"`, options);
    this.name = "RenderError";
  }
}
