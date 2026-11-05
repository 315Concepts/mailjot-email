import { z } from "zod";

const httpsUrl = z.url({ protocol: /^https$/ });

export const schema = z.strictObject({
  name: z.string().min(1),
  headline: z.string().min(1),
  body: z.string().min(1),
  logoUrl: httpsUrl,
  cta: z.strictObject({ label: z.string().min(1), url: httpsUrl }),
  features: z.array(z.strictObject({ title: z.string().min(1), description: z.string().min(1) })).min(1).max(4),
});

export type Input = z.infer<typeof schema>;
