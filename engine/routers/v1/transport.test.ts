import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { TransportContractError } from "../../transport.js";
import { transportContractV1 } from "./transport.js";
import { captureLogger } from "../../../test/captureLogger.js";

const NAME = "Demo";

/** A module that satisfies the v1 contract; tests override or remove one thing at a time. */
const validModule = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  metadata: { id: NAME, description: "A demo transport." },
  config: z.object({}),
  default: async () => ({ ok: true, response: {} }),
  ...overrides,
});

const problemsOf = (mod: Record<string, unknown>): string[] => {
  try {
    transportContractV1.assert(NAME, mod);
  } catch (err) {
    expect(err).toBeInstanceOf(TransportContractError);
    expect((err as TransportContractError).transport).toBe(NAME);
    return (err as TransportContractError).problems;
  }
  return [];
};

describe("transportContractV1.assert: a valid module", () => {
  it("is accepted and described", () => {
    const config = z.object({ DEMO_KEY: z.string() });
    const contracted = transportContractV1.assert(NAME, validModule({ config }));
    expect(contracted.description).toBe("A demo transport.");
    expect(contracted.config).toBe(config);
  });

  it("gets a strict, empty options schema when it declares none", () => {
    const { options } = transportContractV1.assert(NAME, validModule());
    expect(options.safeParse({}).success).toBe(true);
    expect(options.safeParse({ anything: 1 }).success).toBe(false);
  });

  it("keeps the options schema it declares", () => {
    const declared = z.strictObject({ tag: z.string().optional() });
    const { options } = transportContractV1.assert(NAME, validModule({ options: declared }));
    expect(options).toBe(declared);
    expect(options.safeParse({ tag: "x" }).success).toBe(true);
  });

  it("calls the module's send with the message and the parsed config, and returns its result", async () => {
    const send = vi.fn(async () => ({ ok: true as const, messageId: "m-1", response: { accepted: true } }));
    const { send: contractedSend } = transportContractV1.assert(NAME, validModule({ default: send }));

    const message = {
      template: "accounts/welcome",
      version: "1.0.0",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
      envelope: { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }] },
      options: { tag: "x" },
      logger: captureLogger().logger,
    };
    const result = await contractedSend(message, { DEMO_KEY: "k" });

    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ ...message, config: { DEMO_KEY: "k" } });
    expect(result).toEqual({ ok: true, messageId: "m-1", response: { accepted: true } });
  });
});

describe("transportContractV1.assert: violations", () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ["metadata is missing", { metadata: undefined }, "`metadata` must be an object"],
    ["metadata is null", { metadata: null }, "`metadata` must be an object"],
    ["metadata is a string", { metadata: "Demo" }, "`metadata` must be an object"],
    ["metadata.id is missing", { metadata: { description: "d" } }, "`metadata.id` must be a non-empty string"],
    ["metadata.id is empty", { metadata: { id: "", description: "d" } }, "`metadata.id` must be a non-empty string"],
    ["metadata.id is a number", { metadata: { id: 42, description: "d" } }, "`metadata.id` must be a non-empty string"],
    ["metadata.id names another directory", { metadata: { id: "Other", description: "d" } }, '`metadata.id` ("Other") must match the directory name ("Demo")'],
    ["metadata.description is missing", { metadata: { id: NAME } }, "`metadata.description` must be a non-empty string"],
    ["metadata.description is empty", { metadata: { id: NAME, description: "" } }, "`metadata.description` must be a non-empty string"],
    ["metadata.description is a number", { metadata: { id: NAME, description: 5 } }, "`metadata.description` must be a non-empty string"],
    ["config is missing", { config: undefined }, "`config` must be a Zod schema over environment variables"],
    ["config is a plain object", { config: { DEMO_KEY: "string" } }, "`config` must be a Zod schema over environment variables"],
    ["options is not a Zod schema (an object)", { options: { tag: "string" } }, "`options`, if present, must be a Zod schema"],
    ["options is not a Zod schema (a string)", { options: "none" }, "`options`, if present, must be a Zod schema"],
    ["options is null", { options: null }, "`options`, if present, must be a Zod schema"],
    ["default is missing", { default: undefined }, "`default` must be a send function"],
    ["default is not a function", { default: "send" }, "`default` must be a send function"],
  ];

  it.each(cases)("rejects a module whose %s, naming exactly that problem", (_label, overrides, message) => {
    expect(problemsOf(validModule(overrides))).toEqual([message]);
  });

  it("accepts options that are absent (undefined), unlike options that are present but wrong", () => {
    expect(problemsOf(validModule({ options: undefined }))).toEqual([]);
  });

  it("lists every problem at once, so an author fixes them in one pass", () => {
    expect(problemsOf({})).toEqual([
      "`metadata` must be an object",
      "`config` must be a Zod schema over environment variables",
      "`default` must be a send function",
    ]);

    expect(
      problemsOf({ metadata: { id: "Other", description: "" }, config: {}, options: 1, default: null }),
    ).toEqual([
      '`metadata.id` ("Other") must match the directory name ("Demo")',
      "`metadata.description` must be a non-empty string",
      "`config` must be a Zod schema over environment variables",
      "`options`, if present, must be a Zod schema",
      "`default` must be a send function",
    ]);
  });

  it("does not look inside metadata when metadata itself is not an object", () => {
    // One problem, not three: there is no id or description to complain about.
    expect(problemsOf(validModule({ metadata: 7 }))).toHaveLength(1);
  });
});
