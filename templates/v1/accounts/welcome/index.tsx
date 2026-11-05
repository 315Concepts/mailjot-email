import { Body, Container, Html, Text } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "accounts/welcome",
  version: "1.0.0",
  description: "Welcome email sent to new accounts.",
};

export const subject = (input: Input) => `Welcome aboard, ${input.name}!`;

export const examples: Record<string, Input> = {
  default: { name: "Alice" },
};

export default function Welcome({ name }: Input) {
  return (
    <Html>
      <Body>
        <Container>
          <Text>{`Welcome aboard, ${name}!`}</Text>
        </Container>
      </Body>
    </Html>
  );
}
