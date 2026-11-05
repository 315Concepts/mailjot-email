import { z } from "zod";

// No variables: the email only says that no account exists for the address.
export const schema = z.strictObject({});

export type Input = z.infer<typeof schema>;
