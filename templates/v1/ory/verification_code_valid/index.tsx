import { Body, Button, Container, Head, Html, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "ory/verification_code_valid",
  version: "1.0.0",
  description: "Ory Kratos verification email (code method): a code, plus a link that verifies the same address.",
};

export const subject = "Verify Your Account";

export const examples: Record<string, Input> = {
  default: {
    verificationCode: "123456",
    verificationUrl: "https://example.com/verification?flow=3f1c2a9e&code=123456",
    expiresInMinutes: "60",
  },
};

// pixelBasedPreset converts spacing and font sizes to px but leaves border radius, max width and letter spacing in
// rem/em; the ones used here are pinned to px.
const config = {
  presets: [pixelBasedPreset],
  theme: {
    extend: {
      colors: { brand: "#2563eb" },
      borderRadius: { md: "6px" },
      maxWidth: { xl: "576px" },
      letterSpacing: { widest: "4px" },
    },
  },
};

export default function VerificationCodeValid({ verificationCode, verificationUrl, expiresInMinutes }: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Body className="font-sans">
          <Container className="max-w-xl">
            <Text className="mb-0 text-center text-sm text-gray-600">Verification code</Text>
            <Text className="mt-1 text-center text-3xl font-bold tracking-widest text-brand">{verificationCode}</Text>
            <Text className="text-center">Or click the following link:</Text>
            <Text className="text-center">
              <Button href={verificationUrl} className="inline-block rounded-md bg-brand px-6 py-3 text-base font-bold text-white no-underline">
                Verification Link
              </Button>
            </Text>
            <Text className="text-center">{`This code and link expire in ${expiresInMinutes} minutes.`}</Text>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
