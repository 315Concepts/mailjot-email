import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

/** Shorter tokens are treated as not configured: they are too easy to guess for an endpoint that sends email. */
export const MIN_TOKEN_LENGTH = 16;

/** Explains why a token value cannot be used, or undefined if it is acceptable. */
export function tokenProblem(token: string | undefined): string | undefined {
  if (token === undefined || token === "") return "MAILJOT_TRANSPORT_AUTH_TOKEN is not set";
  if (token.length < MIN_TOKEN_LENGTH) return `MAILJOT_TRANSPORT_AUTH_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters`;
  return undefined;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Requires `Authorization: Bearer <token>` to match the configured token. Denies every request when
 * no usable token is configured. Missing, malformed and wrong credentials are indistinguishable
 * to the caller, and the comparison is constant-time.
 */
export function bearerAuth(token: string | undefined): RequestHandler {
  const usable = tokenProblem(token) === undefined ? digest(token!) : undefined;

  return (req, res, next) => {
    const match = /^Bearer +(\S+)$/i.exec(req.headers.authorization ?? "");
    if (usable && match && timingSafeEqual(usable, digest(match[1]!))) {
      next();
      return;
    }
    res
      .status(401)
      .set("WWW-Authenticate", 'Bearer realm="mailjot"')
      .json({ error: { code: "unauthorized", message: "Authentication required" } });
  };
}
