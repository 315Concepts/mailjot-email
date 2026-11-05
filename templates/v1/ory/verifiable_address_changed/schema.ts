import { z } from "zod";

// A string, not a date: the value is an Ory template variable (CHANGED_AT), converted to a Go template
// expression afterwards by ../gotmpl. Ory supplies it already formatted.
export const schema = z.strictObject({
  changedAt: z.string().min(1),
});

export type Input = z.infer<typeof schema>;
