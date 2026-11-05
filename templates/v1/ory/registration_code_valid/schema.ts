import { z } from "zod";

// Strings, not an integer: the values are Ory template variables (REGISTRATION_CODE), converted to
// Go template expressions afterwards by ../gotmpl.
export const schema = z.strictObject({
  registrationCode: z.string().min(1),
  expiresInMinutes: z.string().min(1),
});

export type Input = z.infer<typeof schema>;
