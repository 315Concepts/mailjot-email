import { z } from "zod";

// Strings, not a URL and an integer: the values are Ory template variables (RECOVERY_URL), converted to
// Go template expressions afterwards by ../gotmpl.
export const schema = z.strictObject({
  recoveryUrl: z.string().min(1),
  expiresInMinutes: z.string().min(1),
});

export type Input = z.infer<typeof schema>;
