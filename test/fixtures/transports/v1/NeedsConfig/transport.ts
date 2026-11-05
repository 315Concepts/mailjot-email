import { z } from "zod";

export const metadata = { id: "NeedsConfig", description: "Unavailable unless NEEDS_CONFIG_TOKEN is set." };
export const config = z.object({ NEEDS_CONFIG_TOKEN: z.string().min(8, "must be at least 8 characters") });

export default async function send() {
  return { ok: true as const, response: {} };
}
