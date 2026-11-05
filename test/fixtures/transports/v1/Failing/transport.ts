import { z } from "zod";
import type { SendResult } from "../../../../../engine/routers/v1/transport.js";

export const metadata = { id: "Failing", description: "Always reports a provider rejection." };
export const config = z.object({});

export default async function send(): Promise<SendResult> {
  return { ok: false, reason: "rejected", message: "mailbox does not exist", response: { code: 550 } };
}
