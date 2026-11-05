import { z } from "zod";
import type { Address, SendResult, TransportMessage, TransportModule } from "../../../engine/routers/v1/transport.js";

// Mailjet adapter (Send API v3.1). Everything specific to Mailjet lives in this file: the generic
// envelope is translated to Mailjet's request shape on the way out, and Mailjet's response and
// errors are translated back into a SendResult.

export const metadata = {
  id: "Mailjet",
  description: "Sends through the Mailjet Send API (v3.1).",
};

export const config = z.object({
  MAILJET_API_KEY: z.string().min(1, "is required"),
  MAILJET_API_SECRET: z.string().min(1, "is required"),
  /** Override for proxies and tests. */
  MAILJET_API_URL: z.url().default("https://api.mailjet.com"),
});
type Config = z.output<typeof config>;

export const options = z.strictObject({
  /** Validate and render on Mailjet's side without delivering. */
  sandbox: z.boolean().optional(),
  /** Your own reference, echoed back in Mailjet events. */
  customId: z.string().min(1).max(200).optional(),
});
type Options = z.output<typeof options>;

const person = ({ email, name }: Address) => ({ Email: email, ...(name ? { Name: name } : {}) });

/** Builds the request body for POST /v3.1/send from a generic message. Exported for tests. */
export function toMailjetRequest({ envelope, subject, html, text, options }: TransportMessage<Options, Config>) {
  return {
    ...(options.sandbox ? { SandboxMode: true } : {}),
    Messages: [
      {
        From: person(envelope.from),
        To: envelope.to.map(person),
        ...(envelope.cc?.length ? { Cc: envelope.cc.map(person) } : {}),
        ...(envelope.bcc?.length ? { Bcc: envelope.bcc.map(person) } : {}),
        ...(envelope.replyTo ? { ReplyTo: person(envelope.replyTo) } : {}),
        Subject: subject,
        TextPart: text,
        HTMLPart: html,
        ...(options.customId ? { CustomID: options.customId } : {}),
      },
    ],
  };
}

interface MailjetMessageResult {
  Status?: string;
  Errors?: { ErrorCode?: string; ErrorMessage?: string }[];
  To?: { Email?: string; MessageUUID?: string; MessageID?: number | string }[];
}

const send = async (message: TransportMessage<Options, Config>): Promise<SendResult> => {
  const { config, logger } = message;
  const credentials = Buffer.from(`${config.MAILJET_API_KEY}:${config.MAILJET_API_SECRET}`).toString("base64");

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(new URL("/v3.1/send", config.MAILJET_API_URL), {
      method: "POST",
      headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/json" },
      body: JSON.stringify(toMailjetRequest(message)),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    // Only the kind of failure is logged (a timeout, a refused connection), never the error text, which can carry the URL.
    const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
    logger.warn(
      { event: "mailjot.transport.mailjet.unreachable", error: err instanceof Error ? err.name : "error", ...(typeof code === "string" ? { code } : {}), duration_ms: Date.now() - started },
      "Mailjet could not be reached",
    );
    return { ok: false, reason: "unreachable", message: `Mailjet request failed: ${err instanceof Error ? err.name : "error"}` };
  }

  const body: unknown = await res.json().catch(() => undefined);
  if (body === undefined) {
    logger.warn({ event: "mailjot.transport.mailjet.non_json", http_status: res.status, duration_ms: Date.now() - started }, "Mailjet returned a non-JSON response");
    return { ok: false, reason: "unreachable", message: `Mailjet returned a non-JSON response (HTTP ${res.status})` };
  }

  const results = (body as { Messages?: MailjetMessageResult[] }).Messages ?? [];
  const failed = results.find((m) => m.Status !== "success");
  if (!res.ok || results.length === 0 || failed) {
    const detail =
      failed?.Errors?.map((e) => e.ErrorMessage).filter(Boolean).join("; ") ||
      (body as { ErrorMessage?: string }).ErrorMessage ||
      `HTTP ${res.status}`;
    // The codes say why (for example `mj-0013`) without the text, which can echo an address; the caller gets that text.
    const errorCodes = results.flatMap((m) => m.Errors?.map((e) => e.ErrorCode) ?? []).filter((c): c is string => typeof c === "string");
    logger.warn(
      { event: "mailjot.transport.mailjet.rejected", http_status: res.status, ...(errorCodes.length > 0 ? { error_codes: errorCodes } : {}), duration_ms: Date.now() - started },
      "Mailjet did not accept the message",
    );
    // 5xx means Mailjet itself is struggling; anything else is a refusal of this request.
    return { ok: false, reason: res.status >= 500 ? "unreachable" : "rejected", message: `Mailjet rejected the message: ${detail}`, response: body };
  }

  logger.debug({ event: "mailjot.transport.mailjet.sent", http_status: res.status, duration_ms: Date.now() - started }, "Mailjet accepted the message");
  const first = results[0]?.To?.[0];
  return { ok: true, messageId: first?.MessageUUID ?? (first?.MessageID === undefined ? undefined : String(first.MessageID)), response: body };
};

export default send satisfies TransportModule<Options, Config>["default"];
