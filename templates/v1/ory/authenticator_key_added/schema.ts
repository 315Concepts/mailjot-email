import { z } from "zod";

// Strings: the value is an Ory template variable (ADDED_AT), converted to a Go template expression afterwards
// by ../gotmpl. addedAt is a pre-formatted date and time.
export const schema = z.strictObject({
  addedAt: z.string().min(1),
});

export type Input = z.infer<typeof schema>;
