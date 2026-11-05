import { Body, Container, Head, Html, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "ory/verification_invalid",
  version: "1.0.0",
  description: "Ory Kratos verification email (link method) for an address with no account: says that no account exists.",
};

export const subject = "Account Verification Attempt";

export const examples: Record<string, Input> = {
  default: {},
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

export default function VerificationInvalid(_props: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Body className="font-sans">
          <Container className="max-w-xl">
            <Text className="text-center">Someone asked to verify this email address, but we were unable to find an account for this address.</Text>
            <Text className="text-center">If this was you, check if you signed up using a different address.</Text>
            <Text className="text-center">If this was not you, you can ignore this email.</Text>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
