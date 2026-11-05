import { z } from "zod";

// No variables: this email is sent when no account exists for the address.
export const schema = z.strictObject({});

export type Input = z.infer<typeof schema>;
