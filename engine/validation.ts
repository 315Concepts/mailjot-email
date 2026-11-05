import type { z } from "zod";

/** One field-level problem, in a shape that stays stable regardless of Zod internals. */
export interface FieldError {
  /** Location of the offending value; empty for the payload root. */
  path: (string | number)[];
  /** Machine-readable Zod issue code, e.g. `invalid_type`, `unrecognized_keys`, `too_small`. */
  code: string;
  message: string;
}

/** Flattens Zod issues into field errors; unrecognized keys are reported one per key. */
export function formatIssues(issues: z.core.$ZodIssue[]): FieldError[] {
  return issues.flatMap((issue): FieldError[] => {
    const path = issue.path.map((p) => (typeof p === "number" ? p : String(p)));
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        path: [...path, key],
        code: issue.code,
        message: "Unrecognized property",
      }));
    }
    return [{ path, code: issue.code, message: issue.message }];
  });
}
