import { z } from "zod";

const address = z.strictObject({
  email: z.email().max(254),
  name: z.string().min(1).max(200).optional(),
});

/** The engine-owned, provider-neutral envelope. Every transport receives exactly this shape. */
export const envelopeSchema = z
  .strictObject({
    from: address,
    to: z.array(address).min(1).max(50),
    cc: z.array(address).max(50).optional(),
    bcc: z.array(address).max(50).optional(),
    replyTo: address.optional(),
  })
  .refine((e) => e.to.length + (e.cc?.length ?? 0) + (e.bcc?.length ?? 0) <= 100, {
    message: "At most 100 recipients in total",
    path: ["to"],
  });
