import { z } from "zod";

export const CURRENCIES = ["USD", "EUR", "GBP"] as const;

const charge = z.strictObject({
  description: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(99),
  /** Price per unit in minor units (cents), avoiding floating point money. */
  unitPriceCents: z.number().int().min(0),
});

export const schema = z.strictObject({
  customerName: z.string().min(1).max(200),
  orderNumber: z.string().regex(/^[A-Za-z0-9-]{3,40}$/, "Order numbers use letters, digits and hyphens"),
  currency: z.enum(CURRENCIES),
  charges: z.array(charge).min(1).max(100),
});

export type Input = z.infer<typeof schema>;
