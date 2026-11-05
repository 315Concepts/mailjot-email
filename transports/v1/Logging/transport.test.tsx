import { afterEach, describe, expect, it, vi } from "vitest";
import { createV1TransportLoader } from "../../../engine/routers/v1/transport.js";
import { captureLogger } from "../../../test/captureLogger.js";

const transportsRoot = new URL("..", import.meta.url).pathname;

const message = {
  template: "billing/receipt",
  version: "1.0.0",
  subject: "Your receipt",
  html: "<p>Receipt for Alice</p>",
  text: "Receipt for Alice",
  envelope: {
    from: { email: "billing@example.com", name: "Billing" },
    to: [{ email: "alice@example.com", name: "Alice" }],
    cc: [{ email: "cc@example.com" }],
  },
  options: {},
  logger: captureLogger().logger,
};

const load = (env: Record<string, string | undefined> = {}) => createV1TransportLoader(transportsRoot, { env }).load("logging");

/** Runs `send` and returns the lines it wrote to stdout. */
async function sendAndCapture(env: Record<string, string | undefined>, overrides: object = {}) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const transport = await load(env);
    const result = await transport.send({ ...message, ...overrides });
    return { result, lines: log.mock.calls.map((c) => String(c[0])) };
  } finally {
    log.mockRestore();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("Logging transport configuration", () => {
  it("needs no configuration", async () => {
    const transport = await load();
    expect(transport.name).toBe("Logging");
    expect(transport.description).toContain("log");
  });

  it("accepts only true or false for LOGGING_INCLUDE_BODY", async () => {
    await expect(load({ LOGGING_INCLUDE_BODY: "true" })).resolves.toBeDefined();
    await expect(load({ LOGGING_INCLUDE_BODY: "false" })).resolves.toBeDefined();
    await expect(load({ LOGGING_INCLUDE_BODY: "yes" })).rejects.toThrow(/not configured/);
  });

  it("accepts a label option and nothing else", async () => {
    const { optionsSchema } = await load();
    expect(optionsSchema.safeParse({}).success).toBe(true);
    expect(optionsSchema.safeParse({ label: "smoke-test" }).success).toBe(true);
    expect(optionsSchema.safeParse({ label: "" }).success).toBe(false);
    expect(optionsSchema.safeParse({ other: 1 }).success).toBe(false);
  });
});

describe("Logging transport", () => {
  it("writes exactly one JSON line per message, and reports success without delivering anything", async () => {
    const { result, lines } = await sendAndCapture({});
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]!);
    expect(entry).toMatchObject({
      event: "mailjot.message",
      template: "billing/receipt",
      version: "1.0.0",
      subject: "Your receipt",
      envelope: message.envelope,
      bytes: { html: Buffer.byteLength(message.html), text: Buffer.byteLength(message.text) },
    });
    expect(new Date(entry.at).toISOString()).toBe(entry.at);
    expect(result).toEqual({ ok: true, messageId: entry.id, response: { logged: true } });
    expect(entry.id).toMatch(/^log-[0-9a-f-]{36}$/);
  });

  it("leaves the bodies out by default, and includes them when asked", async () => {
    const quiet = JSON.parse((await sendAndCapture({})).lines[0]!);
    expect(quiet).not.toHaveProperty("html");
    expect(quiet).not.toHaveProperty("text");

    const verbose = JSON.parse((await sendAndCapture({ LOGGING_INCLUDE_BODY: "true" })).lines[0]!);
    expect(verbose).toMatchObject({ html: message.html, text: message.text });
  });

  it("adds the label when given", async () => {
    const entry = JSON.parse((await sendAndCapture({}, { options: { label: "smoke-test" } })).lines[0]!);
    expect(entry.label).toBe("smoke-test");
    expect(JSON.parse((await sendAndCapture({})).lines[0]!)).not.toHaveProperty("label");
  });

  it("gives every message its own id", async () => {
    const a = (await sendAndCapture({})).result;
    const b = (await sendAndCapture({})).result;
    expect(a.ok && b.ok && a.messageId !== b.messageId).toBe(true);
  });

  it("cannot be used to forge log lines", async () => {
    const hostile = 'x"}\n{"event":"forged","level":"error"}';
    const { lines } = await sendAndCapture({ LOGGING_INCLUDE_BODY: "true" }, { subject: hostile, html: `<p>${hostile}</p>`, text: hostile });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("\n");
    const entry = JSON.parse(lines[0]!);
    expect(entry.event).toBe("mailjot.message");
    expect(entry.subject).toBe(hostile);
  });
});
