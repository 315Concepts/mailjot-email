import { Body, Container, Head, Html, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "ory/authenticator_key_added",
  version: "1.0.0",
  description: "Ory Kratos notification: an authenticator key was added to the account, and when.",
};

export const subject = "A Security Key Was Added";

export const examples: Record<string, Input> = {
  default: {
    addedAt: "1 November 2026, 14:32 UTC",
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

export default function AuthenticatorKeyAdded({ addedAt }: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Body className="font-sans">
          <Container className="max-w-xl">
            <Text className="text-center">{`A new sign-in method (device key) was added to your account on ${addedAt}.`}</Text>
            <Text className="text-center">If you did this, no further action is needed.</Text>
            <Text className="text-center">If this was not you, secure your account immediately and contact support.</Text>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
