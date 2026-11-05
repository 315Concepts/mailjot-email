import { Html, Text } from "react-email";
import { z } from "zod";

// Deliberately broken: renders, but the output contains an unresolved value, so the integrity
// checks must reject it.
export const schema = z.strictObject({ name: z.string().min(1) });

export const metadata = {
  id: "accounts/leaky",
  version: "1.0.0",
  description: "Test template whose output fails the integrity checks.",
};

export const subject = "Leaky";

export const examples = { default: { name: "Alice" } };

export default function Leaky({ name }: z.infer<typeof schema>) {
  const missing = undefined;
  return (
    <Html>
      <Text>{`Hi ${name}, your code is ${missing}`}</Text>
    </Html>
  );
}
