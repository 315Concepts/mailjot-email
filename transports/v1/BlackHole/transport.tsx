import { z } from "zod";
import type { SendResult, TransportMessage, TransportModule } from "../../../engine/routers/v1/transport.js";

// BlackHole transport: swallows every message. Nothing is delivered, written or recorded, but it is
// never silent about it: each message produces exactly one log line,
//
//   Swallowed <characters> characters on <lines> lines!
//
// The counts cover what actually disappears, the HTML and the plaintext body together. Characters are
// Unicode code points (an emoji is one), and lines are newline-separated lines (a trailing newline does
// not start another line, and an empty body has none). The wording is fixed, so "1 characters on 1
// lines!" is deliberate: the line is meant to be greppable.

export const metadata = {
  id: "BlackHole",
  description: "Swallows every message and logs how much it ate. Nothing is delivered, ever - it's just... gone.",
};

export const config = z.object({});
type Config = z.output<typeof config>;

// No options: anything a caller passes is rejected, like any other unknown property.
export const options = z.strictObject({});
type Options = z.output<typeof options>;

const countCharacters = (s: string): number => Array.from(s).length;

const countLines = (s: string): number => {
  if (s === "") return 0;
  const lines = s.split(/\r\n|\r|\n/);
  return lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
};

const send = async ({ html, text, logger }: TransportMessage<Options, Config>): Promise<SendResult> => {
  const characters = countCharacters(html) + countCharacters(text);
  const lines = countLines(html) + countLines(text);
  logger.info({ event: "mailjot.transport.blackhole.swallowed", characters, lines }, `Swallowed ${characters} characters on ${lines} lines!`);
  return { ok: true, response: { swallowed: true, characters, lines } };
};

export default send satisfies TransportModule<Options, Config>["default"];
