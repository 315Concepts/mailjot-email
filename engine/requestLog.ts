import { randomUUID } from "node:crypto";
import type { RequestHandler, Response } from "express";
import type { Logger } from "./logger.js";

// Node-only, like the logger: not part of the render path that runs in the browser.

declare global {
  namespace Express {
    interface Request {
      /** The engine's logger scoped to this request: every line it writes carries the request's `request_id`. */
      log: Logger;
    }
  }
}

export const REQUEST_ID_HEADER = "X-Request-Id";

/** A caller-supplied request ID is used only if it is short and plain. Anything else is replaced, never echoed. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** What `route` says when no route handler ran: an unknown path, or a request a router's middleware answered itself. */
export const UNMATCHED_ROUTE = "(unmatched)";

/** Names a router adds to the request's access line once it has resolved them (never the raw, untrusted path). */
export interface RequestLogFields {
  template?: string;
  transport?: string;
}

/** Records the resolved template and/or transport on this request's access line. */
export function annotate(res: Response, fields: RequestLogFields): void {
  res.locals.logFields = { ...(res.locals.logFields as RequestLogFields | undefined), ...fields };
}

export interface RequestLogOptions {
  logger: Logger;
  /** Makes an ID when the caller sent none (or an unsafe one). Injectable so tests get predictable IDs. */
  generateId?: () => string;
}

/**
 * Gives each request an ID and a scoped logger (`req.log`), echoes the ID in the `X-Request-Id` response header,
 * and writes one `mailjot.request` line when the response is done.
 *
 * The line records what the request was, never its content: the method, the matched route *pattern* (not the URL,
 * so an unexpected path never becomes a log value), the status, the duration and the size of the response, plus
 * the template and transport a router resolved. No query string, no headers, no body.
 */
export function requestLog({ logger, generateId = randomUUID }: RequestLogOptions): RequestHandler {
  return (req, res, next) => {
    const supplied = req.get("x-request-id");
    const requestId = supplied !== undefined && SAFE_REQUEST_ID.test(supplied) ? supplied : generateId();
    res.setHeader(REQUEST_ID_HEADER, requestId);
    req.log = logger.child({ request_id: requestId });
    const started = performance.now();

    res.on("finish", () => {
      // The pattern a route handler registered (for example `/render/*template`), prefixed with the mount point the
      // engine recorded (`/v1`). `req.baseUrl` is not used: it echoes whatever the client typed (`/V1`).
      const pattern: unknown = req.route?.path;
      const route = typeof pattern === "string" ? `${(res.locals.mount as string | undefined) ?? ""}${pattern}` : UNMATCHED_ROUTE;
      const status = res.statusCode;
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : route === "/healthz" ? "debug" : "info";
      const length = Number(res.getHeader("content-length"));

      req.log[level](
        {
          event: "mailjot.request",
          method: /^[A-Z]{1,10}$/.test(req.method) ? req.method : "OTHER",
          route,
          status,
          duration_ms: Math.round(performance.now() - started),
          ...(Number.isFinite(length) ? { bytes_out: length } : {}),
          ...(res.locals.logFields as RequestLogFields | undefined),
        },
        `${req.method} ${route} ${status}`,
      );
    });

    next();
  };
}
