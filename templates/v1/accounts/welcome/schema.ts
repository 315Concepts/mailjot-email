import { z } from "zod";

export const schema = z.strictObject({
  name: z.string().min(1),
});

export type Input = z.infer<typeof schema>;
