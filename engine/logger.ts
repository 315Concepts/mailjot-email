import { readFileSync } from "node:fs";
import path from "node:path";
import pino, { type DestinationStream, type Logger } from "pino";

// Node-only: this module is not part of the render path that Storybook runs in the browser, so it may use
// `node:` modules. Nothing in the browser-safe list (render, integrity, schema, validation, errors, template)
// may import it.

export type { Logger };

const LEVELS = ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const;
type Level = (typeof LEVELS)[number];
const DEFAULT_LEVEL: Level = "info";

/** Keys whose values are never written to the log, wherever they appear in a logged object. */
const SECRET_KEY = /authorization|cookie|api[_-]?key|api[_-]?secret|secret|token|password|passwd/i;
export const REDACTED = "[Redacted]";

const MAX_DEPTH = 8;
const MAX_CAUSES = 5;

/** Reads `LOG_LEVEL`. Unset or empty means the default; anything else that is not a level is reported by the caller. */
export function parseLogLevel(value: string | undefined): { level: Level; invalid?: string } {
  const requested = value?.trim().toLowerCase();
  if (!requested) return { level: DEFAULT_LEVEL };
  const level = LEVELS.find((l) => l === requested);
  return level ? { level } : { level: DEFAULT_LEVEL, invalid: value };
}

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Returns a copy of `value` with every secret-named key's value replaced. Only plain objects and arrays are
 * walked; Errors and other instances are left to their serializer. The input is never modified, and cycles and
 * very deep structures cannot make logging throw or hang.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value) || isPlain(value)) {
    if (seen.has(value)) return "[Circular]";
    if (depth >= MAX_DEPTH) return "[Truncated]";
    seen.add(value);
    const copy = Array.isArray(value)
      ? value.map((item) => redact(item, depth + 1, seen))
      : Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) ? REDACTED : redact(item, depth + 1, seen)]),
        );
    seen.delete(value);
    return copy;
  }
  return value;
}

export interface SerializedError {
  type: string;
  message: string;
  code?: string | number;
  stack?: string;
  cause?: SerializedError;
}

/**
 * What an error looks like in the log: its type, message, code and stack, then the `cause` chain the same way.
 * Nothing else on the error or its causes is logged, because a provider error can carry a response body or a
 * request. A value that is not an Error is described by its type; only a thrown string is kept as the message.
 */
export function serializeError(err: unknown, causes = 0): SerializedError {
  if (!(err instanceof Error)) {
    return { type: typeof err, message: typeof err === "string" ? err : `(non-Error value of type ${err === null ? "null" : typeof err})` };
  }
  const code = (err as { code?: unknown }).code;
  const serialized: SerializedError = {
    type: err.name,
    message: err.message,
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    ...(err.stack ? { stack: err.stack } : {}),
  };
  if (err.cause !== undefined && causes < MAX_CAUSES) serialized.cause = serializeError(err.cause, causes + 1);
  return serialized;
}

/**
 * The version in the `package.json` named `mailjot`, found by walking up from `startDir` (this file sits at a different
 * depth in `dist/` than in the source tree). `"unknown"` if there is none within four levels.
 */
export function findPackageVersion(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; version?: string };
      if (pkg.name === "mailjot" && pkg.version) return pkg.version;
    } catch {
      // no package.json at this level
    }
    dir = path.dirname(dir);
  }
  return "unknown";
}

export interface LoggerOptions {
  /** Environment to read `LOG_LEVEL` from. */
  env: Record<string, string | undefined>;
  /** Where lines go. Defaults to stdout, written synchronously so a `Fatal` line is out before `process.exit`. */
  destination?: DestinationStream;
}

/**
 * The engine's logger: one JSON object per line, with a level label, an ISO timestamp, `service` and `version`.
 * Secret-named keys are redacted and errors are serialized by `serializeError`. These are a backstop; the rule
 * is still never to pass bodies, subjects, recipients or credentials to the logger.
 */
export function createLogger({ env, destination }: LoggerOptions): Logger {
  const { level, invalid } = parseLogLevel(env.LOG_LEVEL);

  const logger = pino(
    {
      level,
      base: { service: "mailjot", version: findPackageVersion(import.meta.dirname) },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: {
        level: (label) => ({ level: label }),
        log: (object) => redact(object) as Record<string, unknown>,
      },
      serializers: { err: serializeError },
    },
    destination ?? pino.destination({ dest: 1, sync: true }),
  );

  if (invalid !== undefined) {
    logger.warn({ event: "mailjot.log.level_invalid", requested: invalid.slice(0, 40), using: level }, "Unknown LOG_LEVEL, using the default");
  }
  return logger;
}
