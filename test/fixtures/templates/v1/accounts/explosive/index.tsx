import { Html, Text } from "react-email";
import { z } from "zod";

// Deliberately broken: satisfies the contract, but validating its input throws an unexpected error
// (as a buggy custom refinement would). The engine must answer with a generic failure and leak nothing.
export const schema = z.strictObject({
  name: z.string().refine(() => {
    throw new Error("secret internal detail at /srv/app/db");
  }),
});

export const metadata = {
  id: "accounts/explosive",
  version: "1.0.0",
  description: "Test template whose schema throws an unexpected error.",
};

export const subject = "Explosive";

export const examples = { default: { name: "Alice" } };

export default function Explosive({ name }: z.infer<typeof schema>) {
  return (
    <Html>
      <Text>{`Hi ${name}`}</Text>
    </Html>
  );
}
