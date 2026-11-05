import { Body, Container, Head, Html, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "ory/verifiable_address_changed",
  version: "1.0.0",
  description: "Ory Kratos notification: a verifiable address (email) on the account was changed, and when.",
};

export const subject = "Your Email Address Was Changed";

export const examples: Record<string, Input> = {
  default: {
    changedAt: "March 4, 2026 at 2:15 PM UTC",
  },
};

// pixelBasedPreset converts spacing and font sizes to px but leaves max width in rem; it is pinned to px.
const config = {
  presets: [pixelBasedPreset],
  theme: {
    extend: {
      maxWidth: { xl: "576px" },
    },
  },
};

export default function VerifiableAddressChanged({ changedAt }: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Body className="font-sans">
          <Container className="max-w-xl">
            <Text className="text-center">{`An email address on your account was changed on ${changedAt}.`}</Text>
            <Text className="text-center">If you made this change, no further action is needed.</Text>
            <Text className="text-center">If you did not make this change, please contact support immediately.</Text>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
