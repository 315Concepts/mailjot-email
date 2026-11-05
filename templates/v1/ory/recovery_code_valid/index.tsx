import { Body, Container, Head, Html, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "ory/recovery_code_valid",
  version: "1.0.0",
  description: "Ory Kratos recovery email (code method): a code the recipient enters to recover their account.",
};

export const subject = "Recover Your Account";

export const examples: Record<string, Input> = {
  default: {
    recoveryCode: "482915",
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

export default function RecoveryCodeValid({ recoveryCode, expiresInMinutes }: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Body className="font-sans">
          <Container className="max-w-xl">
            <Text className="mb-0 text-center text-sm text-gray-600">Recovery code</Text>
            <Text className="mt-1 text-center text-3xl font-bold tracking-widest text-brand">{recoveryCode}</Text>
            <Text className="text-center">{`This code expires in ${expiresInMinutes} minutes.`}</Text>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
