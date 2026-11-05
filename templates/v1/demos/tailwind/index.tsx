import { Body, Button, Column, Container, Head, Heading, Hr, Html, Img, Link, Preview, Row, Section, Tailwind, Text, pixelBasedPreset } from "react-email";
import { schema, type Input } from "./schema.js";

export { schema };

export const metadata = {
  id: "demos/tailwind",
  version: "1.0.0",
  description: "Demonstrates rich Tailwind styling in an email: brand colours, a logo, a call to action and a features grid.",
};

export const subject = (input: Input) => input.headline;

export const examples: Record<string, Input> = {
  default: {
    name: "Alice",
    headline: "Your workspace is ready",
    body: "Everything is set up and waiting for you. Here is a quick look at what you can do first.",
    logoUrl: "https://315concepts.com/favicon.ico",
    cta: { label: "Open your workspace", url: "https://example.com/workspace" },
    features: [
      { title: "Invite your team", description: "Add colleagues by email and choose what each of them can see." },
      { title: "Import your data", description: "Bring in a spreadsheet and we will map the columns for you." },
      { title: "Set up reports", description: "Pick a weekly summary and it arrives in your inbox on Monday." },
      { title: "Connect your tools", description: "Link the apps you already use so nothing needs retyping." },
    ],
  },
  short: {
    name: "Bob",
    headline: "A quick note",
    body: "One thing worth knowing before you start.",
    logoUrl: "https://315concepts.com/favicon.ico",
    cta: { label: "Read more", url: "https://example.com/notes" },
    features: [{ title: "Only one", description: "A single feature still lays out cleanly." }],
  },
};

// pixelBasedPreset converts spacing and font sizes to px but leaves border radius, max width and letter spacing in
// rem/em, which many email clients handle inconsistently. The ones this template uses are pinned to px here.
const config = {
  presets: [pixelBasedPreset],
  theme: {
    extend: {
      colors: { brand: { DEFAULT: "#4f46e5", dark: "#3730a3", soft: "#eef2ff" } },
      borderRadius: { md: "6px", lg: "8px", xl: "12px" },
      maxWidth: { xl: "576px" },
      letterSpacing: { wide: "0.4px" },
    },
  },
};

export default function TailwindDemo({ name, headline, body, logoUrl, cta, features }: Input) {
  return (
    <Tailwind config={config}>
      <Html>
        <Head />
        <Preview>{headline}</Preview>
        <Body className="m-0 bg-gray-100 py-6 font-sans">
          <Container className="max-w-xl overflow-hidden rounded-xl bg-white">
            <Section className="bg-brand px-6 py-5 sm:px-10">
              <Row>
                <Column className="w-12 align-middle">
                  <Img src={logoUrl} alt="Acme" width="40" height="40" className="rounded-lg bg-white" />
                </Column>
                <Column className="pl-3 align-middle">
                  <Text className="m-0 text-lg font-bold text-white">Acme</Text>
                </Column>
              </Row>
            </Section>

            <Section className="px-6 pt-8 pb-2 sm:px-10">
              <Text className="m-0 text-sm font-semibold text-brand">{`Welcome, ${name}`}</Text>
              <Heading as="h1" className="m-0 mt-2 text-3xl font-bold text-gray-900">
                {headline}
              </Heading>
              <Text className="mt-4 mb-0 text-base text-gray-600">{body}</Text>
              <Button href={cta.url} className="mt-6 rounded-lg bg-brand px-6 py-3 text-base font-semibold text-white">
                {cta.label}
              </Button>
            </Section>

            <Section className="px-6 py-6 sm:px-10">
              <Text className="m-0 mb-3 text-xs font-semibold tracking-wide text-gray-500">GETTING STARTED</Text>
              {features.map((f, i) => (
                <Row key={i} className="mb-3">
                  <Column className="w-8 align-top">
                    <Text className="m-0 h-6 w-6 rounded-md bg-brand-soft text-center text-sm font-bold leading-6 text-brand">{String(i + 1)}</Text>
                  </Column>
                  <Column className="pl-3 align-top">
                    <Text className="m-0 text-base font-semibold text-gray-900">{f.title}</Text>
                    <Text className="m-0 text-sm text-gray-600">{f.description}</Text>
                  </Column>
                </Row>
              ))}
            </Section>

            <Hr className="m-0 border-gray-200" />
            <Section className="bg-gray-50 px-6 py-5 sm:px-10">
              <Text className="m-0 text-xs text-gray-500">
                {"You are receiving this because an account was created for "}
                <Link href="https://example.com/account" className="text-brand-dark underline">
                  your address
                </Link>
                {". Acme, 1 Example Street, Sampleville."}
              </Text>
            </Section>
          </Container>
        </Body>
      </Html>
    </Tailwind>
  );
}
