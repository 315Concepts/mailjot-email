import { z } from "zod";

// No variables: this email says nothing about the address beyond the fact that it has no account.
export const schema = z.strictObject({});

export type Input = z.infer<typeof schema>;
