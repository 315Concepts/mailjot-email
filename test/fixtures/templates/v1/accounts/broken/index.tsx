import { Html, Text } from "react-email";
import { z } from "zod";

// Deliberately broken: passes the contract and validation but always fails to render.
// Lives under test/fixtures so it is never built, shipped or discovered by the real engine.
export const schema = z.strictObject({ name: z.string().min(1) });

export const metadata = {
  id: "accounts/broken",
  version: "1.0.0",
  description: "Test template that always fails to render.",
};

export const subject = "Broken";

export const examples = { default: { name: "Alice" } };

export default function Broken(_props: z.infer<typeof schema>) {
  throw new Error("intentional failure at /srv/secret/path");
  return (
    <Html>
      <Text>unreachable</Text>
    </Html>
  );
}
