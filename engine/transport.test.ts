import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { envelopeSchema } from "./routers/v1/envelope.js";
import { createV1TransportLoader } from "./routers/v1/transport.js";
import {
  createTransportLoader,
  discoverTransports,
  resolveTransport,
  TransportContractError,
  TransportNotFoundError,
  TransportUnavailableError,
} from "./transport.js";

const fixtures = fileURLToPath(new URL("../test/fixtures/transports/v1", import.meta.url));
const realRoot = fileURLToPath(new URL("../transports/v1", import.meta.url));
import { captureLogger } from "../test/captureLogger.js";

const message = {
  template: "accounts/welcome",
  version: "1.0.0",
  subject: "Hi",
  html: "<p>Hi</p>",
  text: "Hi",
  envelope: { from: { email: "a@example.com" }, to: [{ email: "b@example.com" }] },
  options: {},
  logger: captureLogger().logger,
};

describe("discovery", () => {
  it("finds transports by file name", async () => {
    const names = (await discoverTransports(fixtures)).map((t) => t.name);
    expect(names).toEqual(["Broken", "Failing", "InMemory", "NeedsConfig"]);
  });

  it("ships Mailjet as the default transport", async () => {
    expect((await discoverTransports(realRoot)).map((t) => t.name)).toContain("Mailjet");
  });

  describe("in a scratch directory", () => {
    let root: string;
    const write = async (file: string) => {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), "export {};");
    };

    beforeAll(async () => {
      root = await mkdtemp(path.join(os.tmpdir(), "mailjot-transports-"));
      for (const f of [
        "Real/transport.js",
        "Real/transport.test.tsx",
        "Real/helper.js",
        "contract.ts",
        "Stray.js",
        "NoEntry/readme.md",
        ".hidden/transport.js",
        "bad name/transport.js",
      ]) {
        await write(f);
      }
    });
    afterAll(() => rm(root, { recursive: true, force: true }));

    it("finds only directories with a transport entry, ignoring files, tests and unsafe names", async () => {
      expect((await discoverTransports(root)).map((t) => t.name)).toEqual(["Real"]);
    });

    it("prefers source over compiled output when both exist", async () => {
      await write("Real/transport.tsx");
      const [real] = await discoverTransports(root);
      expect(real!.entryPath.endsWith(path.join("Real", "transport.tsx"))).toBe(true);
    });

    it("rejects names that differ only in case", async () => {
      const dup = await mkdtemp(path.join(os.tmpdir(), "mailjot-dup-"));
      await mkdir(path.join(dup, "Mailjet"));
      await mkdir(path.join(dup, "MAILJET"));
      await writeFile(path.join(dup, "Mailjet", "transport.js"), "export {};");
      await writeFile(path.join(dup, "MAILJET", "transport.js"), "export {};");
      await expect(discoverTransports(dup)).rejects.toThrow(/differ only in case/);
      await rm(dup, { recursive: true, force: true });
    });

    // A symlinked *directory* is never discovered (directory listing does not report it as a directory),
    // so this is not what the escape guard in resolveTransport protects against; see the tests below.
    it("does not discover a transport directory that is a symlink", async () => {
      const outside = await mkdtemp(path.join(os.tmpdir(), "mailjot-outside-"));
      await writeFile(path.join(outside, "transport.js"), "export {};");
      await symlink(outside, path.join(root, "Escape"));
      expect((await discoverTransports(root)).map((t) => t.name)).not.toContain("Escape");
      await expect(resolveTransport(root, "Escape")).rejects.toBeInstanceOf(TransportNotFoundError);
      await rm(outside, { recursive: true, force: true });
    });
  });

  describe("an entry file that is a symlink", () => {
    // The case the escape guard exists for: a real directory inside the root whose transport.js
    // points somewhere else, so discovery sees nothing unusual but the code would come from outside.
    let base: string;
    let outsideFile: string;

    beforeAll(async () => {
      base = await mkdtemp(path.join(os.tmpdir(), "mailjot-symlink-"));
      const outside = path.join(base, "outside");
      await mkdir(outside);
      outsideFile = path.join(outside, "transport.js");
      // If this module is ever imported it leaves a trace.
      await writeFile(outsideFile, "globalThis.__mailjotEscaped = true; export const metadata = { id: 'Linked', description: 'x' };\n");

      const root = path.join(base, "transports");
      await mkdir(path.join(root, "Linked"), { recursive: true });
      await symlink(outsideFile, path.join(root, "Linked", "transport.js"));

      // A symlink that stays inside the root is fine and must keep working.
      await mkdir(path.join(root, "Real"));
      await writeFile(path.join(root, "Real", "transport.mjs"), "export {};");
      await mkdir(path.join(root, "Alias"));
      await symlink(path.join(root, "Real", "transport.mjs"), path.join(root, "Alias", "transport.js"));
    });
    afterAll(() => rm(base, { recursive: true, force: true }));

    it("is refused as not found when it resolves outside the root, and the outside code is never imported", async () => {
      const root = path.join(base, "transports");
      // Discovery cannot tell: to it, this is an ordinary transport directory.
      expect((await discoverTransports(root)).map((t) => t.name)).toContain("Linked");

      await expect(resolveTransport(root, "Linked")).rejects.toBeInstanceOf(TransportNotFoundError);
      await expect(resolveTransport(root, "linked")).rejects.toBeInstanceOf(TransportNotFoundError);

      const loader = createV1TransportLoader(root, { env: {} });
      await expect(loader.load("Linked")).rejects.toBeInstanceOf(TransportNotFoundError);
      expect((globalThis as { __mailjotEscaped?: boolean }).__mailjotEscaped).toBeUndefined();
    });

    it("is still allowed when it resolves to a file inside the root", async () => {
      const root = path.join(base, "transports");
      const found = await resolveTransport(root, "Alias");
      expect(found.name).toBe("Alias");
      expect(found.entryPath).toBe(path.join(root, "Alias", "transport.js"));
    });
  });
});

describe("name resolution", () => {
  it("matches case-insensitively and returns the canonical file name", async () => {
    for (const requested of ["InMemory", "inmemory", "INMEMORY", "inMemory"]) {
      expect((await resolveTransport(fixtures, requested)).name).toBe("InMemory");
    }
  });

  it.each(["", "..", "../InMemory", "InMemory/..", "InMem/ory", "InMemory.ts", "contract", "/etc/passwd", "a\\b", "InMemory\0", " InMemory", "nope"])(
    "treats %j as not found",
    async (requested) => {
      await expect(resolveTransport(fixtures, requested)).rejects.toBeInstanceOf(TransportNotFoundError);
    },
  );
});

describe("loader", () => {
  it("loads a valid transport, applying config defaults, and sends through it", async () => {
    const loader = createV1TransportLoader(fixtures, { env: {} });
    const transport = await loader.load("inmemory");
    expect(transport.name).toBe("InMemory");
    expect(transport.description).toBe("Keeps messages in memory.");

    const result = await transport.send({ ...message, options: { tag: "x" } });
    expect(result).toMatchObject({ ok: true, messageId: "mem-1" });
    expect(await loader.load("InMemory")).toBe(transport);
  });

  it("passes parsed config from the environment to send", async () => {
    const transport = await createV1TransportLoader(fixtures, { env: { INMEMORY_PREFIX: "env" } }).load("InMemory");
    expect(await transport.send(message)).toMatchObject({ messageId: expect.stringMatching(/^env-/) });
  });

  it("exposes the transport's options schema, and a strict empty one when it declares none", async () => {
    const loader = createV1TransportLoader(fixtures, { env: { NEEDS_CONFIG_TOKEN: "long-enough-token" } });
    const withOptions = await loader.load("InMemory");
    expect(withOptions.optionsSchema.safeParse({ tag: "a" }).success).toBe(true);
    expect(withOptions.optionsSchema.safeParse({ other: 1 }).success).toBe(false);

    const without = await loader.load("NeedsConfig");
    expect(without.optionsSchema.safeParse({}).success).toBe(true);
    expect(without.optionsSchema.safeParse({ anything: 1 }).success).toBe(false);
  });

  it("reports a provider rejection as a value, not an exception", async () => {
    const transport = await createV1TransportLoader(fixtures, { env: {} }).load("Failing");
    expect(await transport.send(message)).toEqual({
      ok: false,
      reason: "rejected",
      message: "mailbox does not exist",
      response: { code: 550 },
    });
  });

  it("treats missing or invalid config as unavailable, naming the variable", async () => {
    const missing = createV1TransportLoader(fixtures, { env: {} });
    const err = await missing.load("NeedsConfig").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportUnavailableError);
    expect((err as TransportUnavailableError).problems.join()).toContain("NEEDS_CONFIG_TOKEN");

    await expect(createV1TransportLoader(fixtures, { env: { NEEDS_CONFIG_TOKEN: "short" } }).load("NeedsConfig")).rejects.toThrow(
      TransportUnavailableError,
    );
  });

  it("does not cache a failed load", async () => {
    const env: Record<string, string> = {};
    const loader = createV1TransportLoader(fixtures, { env });
    await expect(loader.load("NeedsConfig")).rejects.toThrow(TransportUnavailableError);
    env.NEEDS_CONFIG_TOKEN = "now-it-is-long-enough";
    expect((await loader.load("NeedsConfig")).name).toBe("NeedsConfig");
  });

  it("rejects a module that violates the contract and lists every problem", async () => {
    const err = await createV1TransportLoader(fixtures, { env: {} }).load("Broken").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportContractError);
    const problems = (err as TransportContractError).problems.join("\n");
    expect(problems).toContain("metadata.id");
    expect(problems).toContain("metadata.description");
    expect(problems).toContain("config");
    expect(problems).toContain("default");
  });

  it("lists every transport with its availability, without throwing", async () => {
    const list = await createV1TransportLoader(fixtures, { env: {} }).list();
    expect(list.map((t) => [t.name, t.available])).toEqual([
      ["Broken", false],
      ["Failing", true],
      ["InMemory", true],
      ["NeedsConfig", false],
    ]);
    expect(list.find((t) => t.name === "NeedsConfig")!.problems!.join()).toContain("NEEDS_CONFIG_TOKEN");
    expect(list.find((t) => t.name === "InMemory")!.description).toBe("Keeps messages in memory.");
  });
});

describe("envelope schema", () => {
  const ok = { from: { email: "a@example.com", name: "A" }, to: [{ email: "b@example.com" }] };

  it("accepts a minimal and a full envelope", () => {
    expect(envelopeSchema.safeParse(ok).success).toBe(true);
    expect(
      envelopeSchema.safeParse({ ...ok, cc: [{ email: "c@example.com" }], bcc: [{ email: "d@example.com" }], replyTo: { email: "r@example.com" } }).success,
    ).toBe(true);
  });

  it.each([
    ["no recipients", { ...ok, to: [] }],
    ["a bad address", { ...ok, to: [{ email: "not-an-email" }] }],
    ["a missing sender", { to: ok.to }],
    ["an unknown property", { ...ok, headers: { "X-Evil": "1" } }],
    ["an unknown address property", { ...ok, from: { email: "a@example.com", extra: 1 } }],
    ["too many recipients", { ...ok, to: Array.from({ length: 50 }, (_, i) => ({ email: `t${i}@example.com` })), cc: Array.from({ length: 50 }, (_, i) => ({ email: `c${i}@example.com` })), bcc: [{ email: "x@example.com" }] }],
  ])("rejects %s", (_label, bad) => {
    expect(envelopeSchema.safeParse(bad).success).toBe(false);
  });
});

describe("the generic loader is contract-agnostic", () => {
  // A made-up contract version: the loader only knows what the contract tells it.
  const fakeContract = {
    assert(name: string, mod: Record<string, unknown>) {
      if (typeof mod.default !== "function") throw new TransportContractError(name, ["fake contract wants a default function"]);
      return {
        description: `fake ${name}`,
        config: z.object({}),
        options: z.strictObject({ only: z.string().optional() }),
        send: async (message: { to: string }, config: unknown) => ({ via: "fake-contract", message, config }),
      };
    },
  };

  it("loads and sends through whatever contract it is given", async () => {
    const loader = createTransportLoader(fixtures, { env: {}, contract: fakeContract });
    const transport = await loader.load("InMemory");
    expect(transport.description).toBe("fake InMemory");
    expect(transport.optionsSchema.safeParse({ only: "x" }).success).toBe(true);
    expect(transport.optionsSchema.safeParse({ tag: "v1-only-option" }).success).toBe(false);
    expect(await transport.send({ to: "someone" })).toEqual({ via: "fake-contract", message: { to: "someone" }, config: {} });
  });

  it("applies the contract's own checks, not v1's", async () => {
    // Broken is rejected under v1 too, but for different reasons; here only the fake contract's rule applies.
    const err = await createTransportLoader(fixtures, { env: {}, contract: fakeContract }).load("Broken").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportContractError);
    expect((err as TransportContractError).problems).toEqual(["fake contract wants a default function"]);
  });
});


describe("listing transports that fail before the contract is even checked", () => {
  let root: string;

  // Whatever the contract is, a module that cannot be imported never reaches it.
  const permissive = {
    assert: (name: string) => ({
      description: `fine ${name}`,
      config: z.object({}),
      options: z.strictObject({}),
      send: async () => ({}),
    }),
  };

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mailjot-badimport-"));
    const modules: Record<string, string> = {
      Fine: "export {};",
      Throws: "throw new Error('boom while importing');",
      Plain: "throw 'a plain string, not an Error';",
      Syntax: "export const = ;",
    };
    for (const [name, code] of Object.entries(modules)) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "transport.js"), code);
    }
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("reports each as unavailable with its message, and still lists the healthy ones", async () => {
    const list = await createTransportLoader(root, { env: {}, contract: permissive }).list();

    expect(list.map((t) => [t.name, t.available])).toEqual([
      ["Fine", true],
      ["Plain", false],
      ["Syntax", false],
      ["Throws", false],
    ]);
    const problems = (name: string) => list.find((t) => t.name === name)!.problems;
    expect(problems("Throws")).toEqual(["boom while importing"]);
    expect(problems("Plain")).toEqual(["a plain string, not an Error"]); // a thrown non-Error is stringified
    expect(problems("Syntax")).toHaveLength(1); // the engine's own SyntaxError message
    expect(list.find((t) => t.name === "Fine")).toMatchObject({ available: true, description: "fine Fine" });
  });

  it("surfaces the original error from load(), not a wrapper", async () => {
    const loader = createTransportLoader(root, { env: {}, contract: permissive });
    await expect(loader.load("Throws")).rejects.toThrow("boom while importing");
    // The exact class depends on the runtime (Node, or the bundler under vitest); it is an Error with a message.
    const syntax = await loader.load("Syntax").catch((e: unknown) => e);
    expect(syntax).toBeInstanceOf(Error);
    expect((syntax as Error).message).not.toBe("");
  });

  it("does not remember a failed import, so listing again gives the same answer", async () => {
    const loader = createTransportLoader(root, { env: {}, contract: permissive });
    const first = await loader.list();
    const second = await loader.list();
    expect(second).toEqual(first);
  });
});
