import { Body, Button, Container, Head, Html, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "ory/verification_valid",
  version: "1.0.0",
  description: "Ory Kratos verification email (link method): asks the recipient to confirm their address.",
};

export const subject = "Verify Your Account";

export const examples: Record<string, Input> = {
  default: {
    verificationUrl: "https://example.com/verification?flow=3f1c2a9e&token=abc123",
    expiresInMinutes: "60",
  },
};

// pixelBasedPreset converts spacing and font sizes to px but leaves border radius and max width in rem/em; the ones used here are pinned to px.
const config = {
  presets: [pixelBasedPreset],
  theme: { extend: { colors: { brand: "#2563eb" }, borderRadius: { md: "6px" }, maxWidth: { xl: "576px" } } },
};

export default function VerificationValid({ verificationUrl, expiresInMinutes }: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Body className="font-sans">
          <Container className="max-w-xl">
            <Text className="text-center">Verify your account by opening the following link:</Text>
            <Text className="text-center">
              <Button href={verificationUrl} className="inline-block rounded-md bg-brand px-6 py-3 text-base font-bold text-white no-underline">
                Verification Link
              </Button>
            </Text>
            <Text className="text-center">{`This link expires in ${expiresInMinutes} minutes.`}</Text>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
