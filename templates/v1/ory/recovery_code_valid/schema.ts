import { z } from "zod";

// Strings, not an integer: the values are Ory template variables (RECOVERY_CODE), converted to Go template
// expressions afterwards by ../gotmpl.
export const schema = z.strictObject({
  recoveryCode: z.string().min(1),
  expiresInMinutes: z.string().min(1),
});

export type Input = z.infer<typeof schema>;
