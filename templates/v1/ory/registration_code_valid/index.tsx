import { Body, Container, Head, Html, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "ory/registration_code_valid",
  version: "1.0.0",
  description: "Ory Kratos registration email (code method): a code to enter to finish creating the account.",
};

export const subject = "Complete Your Registration";

export const examples: Record<string, Input> = {
  default: {
    registrationCode: "482913",
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

export default function RegistrationCodeValid({ registrationCode, expiresInMinutes }: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Body className="font-sans">
          <Container className="max-w-xl">
            <Text className="mb-0 text-center text-sm text-gray-600">Registration code</Text>
            <Text className="mt-1 text-center text-3xl font-bold tracking-widest text-brand">{registrationCode}</Text>
            <Text className="text-center">{`This code expires in ${expiresInMinutes} minutes.`}</Text>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
