import { z } from "zod";
import type { SendResult, TransportMessage } from "../../../../../engine/routers/v1/transport.js";

// Test transport: keeps every message it is asked to send in memory instead of delivering it.
export const sent: TransportMessage<{ tag?: string }, { INMEMORY_PREFIX: string }>[] = [];

export const metadata = { id: "InMemory", description: "Keeps messages in memory." };
export const config = z.object({ INMEMORY_PREFIX: z.string().default("mem") });
export const options = z.strictObject({ tag: z.string().optional() });

export default async function send(message: TransportMessage<{ tag?: string }, { INMEMORY_PREFIX: string }>): Promise<SendResult> {
  sent.push(message);
  return { ok: true, messageId: `${message.config.INMEMORY_PREFIX}-${sent.length}`, response: { stored: sent.length } };
}
