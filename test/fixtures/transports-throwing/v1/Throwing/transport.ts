import { z } from "zod";

// Violates the "failures are values" rule on purpose: throws instead of returning a result.
export const metadata = { id: "Throwing", description: "Throws from send." };
export const config = z.object({});

export default async function send(): Promise<never> {
  throw new Error("boom at /srv/secret/path");
}
