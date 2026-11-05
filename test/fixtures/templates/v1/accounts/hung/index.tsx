import { z } from "zod";

// Deliberately broken: rendering never finishes (the component suspends forever), so only the render
// timeout can end the request.
export const schema = z.strictObject({ name: z.string().min(1) });

export const metadata = {
  id: "accounts/hung",
  version: "1.0.0",
  description: "Test template whose render never completes.",
};

export const subject = "Hung";

export const examples = { default: { name: "Alice" } };

export default function Hung(_props: z.infer<typeof schema>): never {
  throw new Promise(() => {});
}
