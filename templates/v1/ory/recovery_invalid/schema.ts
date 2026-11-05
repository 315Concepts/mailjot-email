import { z } from "zod";

// This email has no variables: Kratos sends the same message to every address that has no account.
export const schema = z.strictObject({});

export type Input = z.infer<typeof schema>;
