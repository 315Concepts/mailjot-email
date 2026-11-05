import { createLogger, type Logger } from "../engine/logger.js";

/** A real engine logger whose lines are collected in memory instead of written to stdout. */
export function captureLogger(env: Record<string, string | undefined> = {}): {
  logger: Logger;
  /** The raw lines written so far, as strings. */
  raw: () => string[];
  /** The lines written so far, parsed. */
  lines: () => Record<string, unknown>[];
  /** Forgets the lines written so far, so a test sees only its own. */
  reset: () => void;
} {
  const raw: string[] = [];
  const logger = createLogger({ env, destination: { write: (line: string) => void raw.push(line) } });
  return {
    logger,
    raw: () => raw,
    lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>),
    reset: () => void raw.splice(0),
  };
}
