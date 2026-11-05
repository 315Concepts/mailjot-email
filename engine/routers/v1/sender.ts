import type { Logger } from "../../logger.js";
import type { TemplateModule } from "../../template.js";
import { envelopeSchema } from "./envelope.js";
import { RenderError, ValidationError } from "../../errors.js";
import { renderTemplate, type RenderOptions } from "../../render.js";
import type { V1LoadedTransport } from "./transport.js";
import { formatIssues, type FieldError } from "../../validation.js";

/**
 * A request-level failure reported as the sender's flat 400 body, not the nested error object used
 * elsewhere. `error` says which layer failed; render-layer failures add a `sub_error`.
 */
export interface FlatError {
  error: "invalid_request" | "render_failed" | "invalid_envelope" | "invalid_options";
  sub_error?: "validation_failed" | "integrity_failed" | "render_failed";
  description: string;
  fields?: FieldError[];
}

export class FlatRequestError extends Error {
  /** `options.cause` carries the internal reason (a RenderError) for the router to log. It is never part of the body. */
  constructor(public readonly body: FlatError, options?: { cause?: unknown }) {
    super(body.description, options);
    this.name = "FlatRequestError";
  }
}

/** The transport reported that it could not deliver. Maps to 502. */
export class SendFailedError extends Error {
  constructor(
    public readonly transport: string,
    public readonly template: string,
    public readonly reason: "rejected" | "unreachable",
    message: string,
    /** The provider's own response, passed through to the caller. */
    public readonly response: unknown,
  ) {
    super(message);
    this.name = "SendFailedError";
  }
}

export interface SendOutcome {
  transport: string;
  template: string;
  version: string;
  subject: string;
  messageId?: string;
  /** Whatever the transport returned, unchanged. Absent on a dry run. */
  response?: unknown;
  /** Set on a dry run: everything was rendered and validated, but nothing was sent. */
  dryRun?: true;
  html?: string;
  text?: string;
}

const BODY_KEYS = ["envelope", "options", "input", "dryRun"];

/**
 * Renders `template` and hands the result to `transport`.
 *
 * Body: `{ envelope, options?, input, dryRun? }`. With `dryRun: true` everything is rendered and validated but `send` is not called. Nothing is sent unless the body is well formed, the template
 * builds completely and passes its integrity checks, and the envelope and options are valid.
 * Throws FlatRequestError (400) or SendFailedError (502); anything else is an internal error.
 */
export async function sendTemplate(
  template: TemplateModule,
  transport: V1LoadedTransport,
  body: unknown,
  renderOptions: RenderOptions,
  /** The request's logger. The transport gets a child of it, tagged with the transport and template. */
  logger: Logger,
): Promise<SendOutcome> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new FlatRequestError({ error: "invalid_request", description: "Request body must be a JSON object" });
  }
  const unknownKeys = Object.keys(body).filter((k) => !BODY_KEYS.includes(k));
  const missing = ["envelope", "input"].filter((k) => !(k in body));
  if (unknownKeys.length > 0 || missing.length > 0) {
    throw new FlatRequestError({
      error: "invalid_request",
      description: "Request body must contain `input` and `envelope`, and may contain `options` and `dryRun`",
      fields: [
        ...unknownKeys.map((k) => ({ path: [k], code: "unrecognized_keys", message: "Unrecognized property" })),
        ...missing.map((k) => ({ path: [k], code: "invalid_type", message: "Required" })),
      ],
    });
  }
  const { envelope: rawEnvelope, options: rawOptions, input, dryRun } = body as {
    envelope: unknown;
    options?: unknown;
    input: unknown;
    dryRun?: unknown;
  };
  if (dryRun !== undefined && typeof dryRun !== "boolean") {
    throw new FlatRequestError({
      error: "invalid_request",
      description: "`dryRun` must be a boolean",
      fields: [{ path: ["dryRun"], code: "invalid_type", message: "Expected boolean" }],
    });
  }

  let rendered;
  try {
    rendered = await renderTemplate(template, input, renderOptions);
  } catch (err) {
    if (err instanceof ValidationError) {
      throw new FlatRequestError({
        error: "render_failed",
        sub_error: "validation_failed",
        description: "Input validation failed",
        fields: formatIssues(err.issues),
      });
    }
    if (err instanceof RenderError) {
      // Internals stay in the server log (the router logs the cause); the caller learns only which layer failed.
      throw new FlatRequestError(
        {
          error: "render_failed",
          sub_error: err.code,
          description: err.code === "integrity_failed" ? `Output failed integrity checks: ${err.detail}` : "Failed to render template",
        },
        { cause: err },
      );
    }
    throw err;
  }

  const envelope = envelopeSchema.safeParse(rawEnvelope);
  if (!envelope.success) {
    throw new FlatRequestError({
      error: "invalid_envelope",
      description: "Envelope validation failed",
      fields: formatIssues(envelope.error.issues),
    });
  }
  const options = transport.optionsSchema.safeParse(rawOptions ?? {});
  if (!options.success) {
    throw new FlatRequestError({
      error: "invalid_options",
      description: `Options validation failed for transport ${transport.name}`,
      fields: formatIssues(options.error.issues),
    });
  }

  const { subject, html, text } = rendered;
  if (dryRun) {
    return { transport: transport.name, template: rendered.template, version: rendered.version, subject, dryRun: true, html, text };
  }
  const result = await transport.send({
    template: rendered.template,
    version: rendered.version,
    subject,
    html,
    text,
    envelope: envelope.data,
    options: options.data,
    logger: logger.child({ transport: transport.name, template: rendered.template }),
  });
  if (!result.ok) {
    throw new SendFailedError(transport.name, rendered.template, result.reason, result.message, result.response);
  }

  return {
    transport: transport.name,
    template: rendered.template,
    version: rendered.version,
    subject,
    ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
    response: result.response,
  };
}
