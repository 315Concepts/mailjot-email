import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SendResult, TransportMessage, TransportModule } from "../../../engine/routers/v1/transport.js";

// Logging transport: delivers nothing. Each message becomes one JSON line on stdout, so it shows up
// in `docker logs` or wherever the engine's output goes. Useful in development, in staging, and as a
// dry-run sink that still exercises the whole sender pipeline.

export const metadata = {
  id: "Logging",
  description: "Writes each message to the log as one JSON line instead of sending it.",
};

export const config = z.object({
  /** Also log the full HTML and plaintext bodies. Off by default: bodies can be large and personal. */
  LOGGING_INCLUDE_BODY: z.enum(["true", "false"]).default("false"),
});
type Config = z.output<typeof config>;

export const options = z.strictObject({
  /** A free-form tag added to the log line, for finding it again. */
  label: z.string().min(1).max(100).optional(),
});
type Options = z.output<typeof options>;

const send = async ({ template, version, subject, html, text, envelope, options, config }: TransportMessage<Options, Config>): Promise<SendResult> => {
  const id = `log-${randomUUID()}`;
  const entry = {
    event: "mailjot.message",
    at: new Date().toISOString(),
    id,
    ...(options.label ? { label: options.label } : {}),
    template,
    version,
    subject,
    envelope,
    bytes: { html: Buffer.byteLength(html), text: Buffer.byteLength(text) },
    ...(config.LOGGING_INCLUDE_BODY === "true" ? { html, text } : {}),
  };
  // JSON.stringify escapes newlines, so a hostile subject or body cannot forge extra log lines.
  console.log(JSON.stringify(entry));
  return { ok: true, messageId: id, response: { logged: true } };
};

export default send satisfies TransportModule<Options, Config>["default"];
