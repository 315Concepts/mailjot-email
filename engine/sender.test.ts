import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sent } from "../test/fixtures/transports/v1/InMemory/transport.js";
import { captureLogger } from "../test/captureLogger.js";
import type { Logger } from "./logger.js";
import { createApp } from "./app.js";

const templates = fileURLToPath(new URL("../templates", import.meta.url));
const fixtureTemplates = fileURLToPath(new URL("../test/fixtures/templates", import.meta.url));
const transportsRoot = fileURLToPath(new URL("../test/fixtures/transports", import.meta.url));

interface Running {
  server: Server;
  base: string;
}

const TOKEN = "test-sender-token-0123456789";

/** What the shared servers log; a test calls `logs.reset()` first, then reads only its own lines. */
const logs = captureLogger();

async function listen(
  templatesRoot: string,
  extra: { transportsRoot?: string; env?: Record<string, string | undefined>; logger?: Logger } = {},
): Promise<Running> {
  const { env = { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, ...rest } = extra;
  const server = (await createApp(templatesRoot, { env, logger: logs.logger, ...rest })).listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let real: Running; // real templates + fixture transports
let broken: Running; // fixture (deliberately broken) templates + fixture transports
let noTransports: Running; // real templates, no transports at all
let emptyTransports: Running; // transports root with no files for v1
let missingTransports: Running; // transports root that does not exist at all

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  real = await listen(templates, { transportsRoot });
  broken = await listen(fixtureTemplates, { transportsRoot });
  noTransports = await listen(templates);
  emptyTransports = await listen(templates, { transportsRoot: templates });
  missingTransports = await listen(templates, { transportsRoot: path.join(os.tmpdir(), "mailjot-does-not-exist", "transports") });
});
afterAll(async () => {
  await Promise.all([real, broken, noTransports, emptyTransports, missingTransports].map((r) => new Promise((res) => r.server.close(res))));
  vi.restoreAllMocks();
});
beforeEach(() => {
  sent.length = 0;
});

const envelope = { from: { email: "billing@example.com", name: "Billing" }, to: [{ email: "alice@example.com", name: "Alice" }] };
const authed = { Authorization: `Bearer ${TOKEN}` };
const send = (app: Running, p: string, body: unknown, contentType = "application/json", headers: Record<string, string> = authed) =>
  fetch(`${app.base}/v1/sender/${p}`, {
    method: "POST",
    headers: { "Content-Type": contentType, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const list = (app: Running, headers: Record<string, string> = authed) => fetch(`${app.base}/v1/sender`, { headers });
const welcome = { envelope, input: { name: "Alice" } };

describe("GET /v1/sender", () => {
  it("lists transports with availability, the common envelope schema and each transport's options", async () => {
    const res = await list(real);
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.envelope).toMatchObject({ type: "object", required: expect.arrayContaining(["from", "to"]) });
    const byName = Object.fromEntries(body.transports.map((t: { name: string }) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["Broken", "Failing", "InMemory", "NeedsConfig"]);
    expect(byName.InMemory).toMatchObject({ available: true, description: "Keeps messages in memory." });
    expect(byName.InMemory.options.properties).toHaveProperty("tag");
    expect(byName.Failing.available).toBe(true);
  });

  it("reports unavailable transports without saying why", async () => {
    logs.reset();
    const text = await (await list(real)).text();
    const byName = Object.fromEntries(JSON.parse(text).transports.map((t: { name: string }) => [t.name, t]));
    expect(byName.NeedsConfig).toEqual({ name: "NeedsConfig", available: false });
    expect(byName.Broken).toEqual({ name: "Broken", available: false });
    expect(text).not.toContain("NEEDS_CONFIG_TOKEN");
    // The operator is told why, in the log.
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({ level: "warn", event: "mailjot.transport.unavailable", transport: "NeedsConfig", problems: [expect.stringContaining("NEEDS_CONFIG_TOKEN")] }),
    );
  });
});

describe("POST /v1/sender/{transport}/{template}", () => {
  it("renders the template and sends it through the named transport", async () => {
    const res = await send(real, "InMemory/accounts/welcome", welcome);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transport: "InMemory",
      template: "accounts/welcome",
      version: "1.0.0",
      subject: "Welcome aboard, Alice!",
      messageId: "mem-1",
      response: { stored: 1 },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      template: "accounts/welcome",
      version: "1.0.0",
      subject: "Welcome aboard, Alice!",
      envelope,
      options: {},
      config: { INMEMORY_PREFIX: "mem" },
    });
    expect(sent[0]!.html).toContain("Welcome aboard, Alice!");
    expect(sent[0]!.text).toContain("Welcome aboard, Alice!");
  });

  it("matches the transport name case-insensitively and reports the canonical name", async () => {
    const res = await send(real, "inmemory/accounts/welcome", welcome);
    expect(res.status).toBe(200);
    expect((await res.json()).transport).toBe("InMemory");
  });

  it("passes validated provider options to the transport", async () => {
    await send(real, "InMemory/accounts/welcome", { ...welcome, options: { tag: "launch" } });
    expect(sent[0]!.options).toEqual({ tag: "launch" });
  });

  it("resolves nested template paths after the transport segment", async () => {
    const res = await send(
      real,
      "InMemory/billing/receipt",
      { envelope, input: { customerName: "Z", orderNumber: "A-1", currency: "GBP", charges: [{ description: "W", quantity: 2, unitPriceCents: 250 }] } },
    );
    expect(res.status).toBe(200);
    expect((await res.json()).subject).toBe("Your receipt for order A-1");
  });

  describe("render-layer failures: a flat 400, and nothing is sent", () => {
    it("validation_failed lists the template's field errors", async () => {
      const res = await send(real, "InMemory/accounts/welcome", { envelope, input: { name: 1, extra: true } });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        error: "render_failed",
        sub_error: "validation_failed",
        description: "Input validation failed",
        fields: [
          { path: ["name"], code: "invalid_type", message: expect.any(String) },
          { path: ["extra"], code: "unrecognized_keys", message: expect.any(String) },
        ],
      });
      expect(sent).toHaveLength(0);
    });

    it("integrity_failed names the failed check", async () => {
      const res = await send(broken, "InMemory/accounts/leaky", { envelope, input: { name: "Alice" } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: "render_failed", sub_error: "integrity_failed" });
      expect(body.description).toContain("unresolved undefined");
      expect(body).not.toHaveProperty("fields");
      expect(sent).toHaveLength(0);
    });

    it("render_failed is generic and leaks nothing internal", async () => {
      logs.reset();
      const res = await send(broken, "InMemory/accounts/broken", { envelope, input: { name: "Alice" } });
      const text = await res.text();
      expect(res.status).toBe(400);
      expect(JSON.parse(text)).toEqual({ error: "render_failed", sub_error: "render_failed", description: "Failed to render template" });
      expect(text).not.toContain("secret");
      // Logged once, with the real cause, by the router.
      const failures = logs.lines().filter((l) => l.event === "mailjot.render.failed");
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ level: "error", template: "accounts/broken", code: "render_failed", err: { type: "RenderError" } });
      expect(sent).toHaveLength(0);
    });
  });

  describe("request validation: a flat 400, and nothing is sent", () => {
    it("invalid_envelope lists the envelope's field errors", async () => {
      const res = await send(real, "InMemory/accounts/welcome", { envelope: { from: { email: "nope" }, to: [], cc: "x" }, input: { name: "Alice" } });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body).toMatchObject({ error: "invalid_envelope", description: "Envelope validation failed" });
      expect(body.fields.map((f: { path: unknown[] }) => f.path.join("."))).toEqual(expect.arrayContaining(["from.email", "to", "cc"]));
      expect(sent).toHaveLength(0);
    });

    it("invalid_options rejects properties the transport does not declare", async () => {
      const res = await send(real, "InMemory/accounts/welcome", { ...welcome, options: { sandbox: true } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: "invalid_options",
        fields: [{ path: ["sandbox"], code: "unrecognized_keys" }],
      });
      expect(sent).toHaveLength(0);
    });

    it.each([
      ["a missing input", { envelope }, [["input"]]],
      ["a missing envelope", { input: { name: "Alice" } }, [["envelope"]]],
      ["an unknown top-level property", { ...welcome, extra: 1 }, [["extra"]]],
    ])("invalid_request for %s", async (_label, body, paths) => {
      const res = await send(real, "InMemory/accounts/welcome", body);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe("invalid_request");
      expect(json.fields.map((f: { path: unknown[] }) => f.path)).toEqual(paths);
      expect(sent).toHaveLength(0);
    });

    it("invalid_request for an array as the body", async () => {
      const res = await send(real, "InMemory/accounts/welcome", []);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_request");
      expect(sent).toHaveLength(0);
    });

    it.each([["null", "null"], ["a string", '"hi"']])("rejects %s as the body before it reaches the pipeline", async (_label, raw) => {
      // Express's strict JSON parser only accepts objects and arrays; this is the standard 400.
      const res = await send(real, "InMemory/accounts/welcome", raw);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
      expect(sent).toHaveLength(0);
    });
  });

  describe("delivery failures", () => {
    it("returns 502 with the provider's response when the transport reports a rejection", async () => {
      const res = await send(real, "Failing/accounts/welcome", welcome);
      expect(res.status).toBe(502);
      expect(await res.json()).toEqual({
        error: {
          code: "send_failed",
          message: "mailbox does not exist",
          details: { transport: "Failing", template: "accounts/welcome", reason: "rejected", response: { code: 550 } },
        },
      });
    });

    it("returns 503 for a transport that is not configured, without naming the missing variables", async () => {
      logs.reset();
      const res = await send(real, "NeedsConfig/accounts/welcome", welcome);
      const text = await res.text();
      expect(res.status).toBe(503);
      expect(JSON.parse(text).error.code).toBe("transport_unavailable");
      expect(text).not.toContain("NEEDS_CONFIG_TOKEN");
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({
          level: "error",
          event: "mailjot.transport.unavailable",
          transport: "NeedsConfig",
          problems: [expect.stringContaining("NEEDS_CONFIG_TOKEN")],
        }),
      );
    });

    it("returns 503 for a transport that violates the contract", async () => {
      logs.reset();
      const res = await send(real, "Broken/accounts/welcome", welcome);
      expect(res.status).toBe(503);
      expect((await res.json()).error.code).toBe("transport_unavailable");
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({ level: "error", event: "mailjot.transport.contract_violation", transport: "Broken", problems: expect.any(Array) }),
      );
    });

    it("returns 500 with a generic body if a transport throws", async () => {
      // The contract says failures are values; an exception is a bug and is not echoed.
      logs.reset();
      const { server, base } = await listen(templates, { transportsRoot: fileURLToPath(new URL("../test/fixtures/transports-throwing", import.meta.url)) });
      try {
        const res = await send({ server, base }, "Throwing/accounts/welcome", welcome);
        const text = await res.text();
        expect(res.status).toBe(500);
        expect(JSON.parse(text).error.code).toBe("internal_error");
        expect(text).not.toContain("boom");
        // The cause is logged for the operator.
        expect(logs.lines()).toContainEqual(
          expect.objectContaining({ level: "error", event: "mailjot.error.unhandled", err: expect.objectContaining({ message: expect.stringContaining("boom") }) }),
        );
      } finally {
        await new Promise((r) => server.close(r));
      }
    });
  });

  describe("not found, and request-body errors", () => {
    it("404s for an unknown transport or template", async () => {
      const t = await send(real, "Nope/accounts/welcome", welcome);
      expect(t.status).toBe(404);
      expect((await t.json()).error.code).toBe("transport_not_found");

      const d = await send(real, "InMemory/accounts/nope", welcome);
      expect(d.status).toBe(404);
      expect((await d.json()).error.code).toBe("template_not_found");
      expect(sent).toHaveLength(0);
    });

    it("404s for traversal in either segment", async () => {
      for (const p of ["..%2FInMemory/accounts/welcome", "InMemory/..%2F..%2Fpackage.json", "%2e%2e/accounts/welcome", "InMemory"]) {
        const res = await send(real, p, welcome);
        expect(res.status, p).toBe(404);
      }
    });

    it("returns the standard errors for a bad body", async () => {
      const malformed = await send(real, "InMemory/accounts/welcome", "{nope");
      expect(malformed.status).toBe(400);
      expect((await malformed.json()).error.code).toBe("bad_request");

      expect((await send(real, "InMemory/accounts/welcome", "x=1", "text/plain")).status).toBe(415);

      // Encoding problems the parser reports: generic bodies, and nothing from the parser leaks.
      for (const [encoding, status] of [["gzip", 400], ["weird", 415]] as const) {
        const res = await send(real, "InMemory/accounts/welcome", JSON.stringify(welcome), "application/json", { ...authed, "Content-Encoding": encoding });
        const text = await res.text();
        expect(res.status, encoding).toBe(status);
        expect(JSON.parse(text)).toEqual({ error: { code: "bad_request", message: "Bad request" } });
        expect(text).not.toMatch(/zlib|incorrect header|weird/i);
      }

      const huge = await send(real, "InMemory/accounts/welcome", JSON.stringify({ ...welcome, input: { name: "x".repeat(2_000_000) } }));
      expect(huge.status).toBe(413);
      expect(sent).toHaveLength(0);
    });
  });
});

describe("a template that cannot be served, through the sender", () => {
  it("answers a contract violation with a generic 500 and sends nothing", async () => {
    logs.reset();
    {
      const res = await send(broken, "InMemory/accounts/malformed", { envelope, input: { name: "Alice" } });
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: { code: "template_unavailable", message: "Template is unavailable" } });
      expect(text).not.toContain("secret-contract-detail");
      expect(sent).toHaveLength(0);
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({ level: "error", event: "mailjot.template.contract_violation", template: "accounts/malformed", problems: expect.any(Array) }),
      );
    }
  });

  it("answers an unexpected exception while validating as a generic 500, not the flat 400, and sends nothing", async () => {
    logs.reset();
    {
      const res = await send(broken, "InMemory/accounts/explosive", { envelope, input: { name: "Alice" } });
      const text = await res.text();
      // A bug in a template is reported as a render-layer 400 only when the engine caught it as a render
      // failure. An exception it did not anticipate is an internal error.
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
      expect(text).not.toContain("secret");
      expect(text).not.toContain("/srv/app");
      expect(sent).toHaveLength(0);
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({ level: "error", event: "mailjot.error.unhandled", err: expect.objectContaining({ message: "secret internal detail at /srv/app/db" }) }),
      );
    }
  });

  it("does the same on a dry run: validating throws before anything else happens", async () => {
    {
      const res = await send(broken, "InMemory/accounts/explosive", { envelope, input: { name: "Alice" }, dryRun: true });
      expect(res.status).toBe(500);
      expect((await res.json()).error.code).toBe("internal_error");
    }
  });
});

describe("dry run", () => {
  it("renders and validates but does not call the transport", async () => {
    const res = await send(real, "InMemory/accounts/welcome", { ...welcome, dryRun: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      transport: "InMemory",
      template: "accounts/welcome",
      version: "1.0.0",
      subject: "Welcome aboard, Alice!",
      dryRun: true,
    });
    expect(body.html).toContain("Welcome aboard, Alice!");
    expect(body.text).toContain("Welcome aboard, Alice!");
    expect(body).not.toHaveProperty("response");
    expect(body).not.toHaveProperty("messageId");
    expect(sent).toHaveLength(0);
  });

  it("does not call a transport that would have failed", async () => {
    const res = await send(real, "Failing/accounts/welcome", { ...welcome, dryRun: true });
    expect(res.status).toBe(200);
    expect((await res.json()).dryRun).toBe(true);
  });

  it("still validates the template input, the envelope and the options", async () => {
    const badInput = await send(real, "InMemory/accounts/welcome", { envelope, input: {}, dryRun: true });
    expect((await badInput.json()).sub_error).toBe("validation_failed");

    const env = await send(real, "InMemory/accounts/welcome", { envelope: { to: [] }, input: { name: "A" }, dryRun: true });
    expect((await env.json()).error).toBe("invalid_envelope");

    const opts = await send(real, "InMemory/accounts/welcome", { ...welcome, options: { nope: 1 }, dryRun: true });
    expect((await opts.json()).error).toBe("invalid_options");
  });

  it("requires dryRun to be a boolean", async () => {
    for (const dryRun of ["true", 1, null]) {
      const res = await send(real, "InMemory/accounts/welcome", { ...welcome, dryRun });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request", fields: [{ path: ["dryRun"] }] });
    }
    expect(sent).toHaveLength(0);
  });

  it("sends for real when dryRun is false", async () => {
    const res = await send(real, "InMemory/accounts/welcome", { ...welcome, dryRun: false });
    expect((await res.json()).messageId).toBe("mem-1");
    expect(sent).toHaveLength(1);
  });
});

describe("authentication", () => {
  const expect401 = async (res: Response) => {
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="mailjot"');
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "Authentication required" } });
  };

  it.each([
    ["no credentials", {}],
    ["the wrong token", { Authorization: "Bearer not-the-right-token-at-all" }],
    ["a token with the right prefix", { Authorization: `Bearer ${TOKEN}x` }],
    ["a truncated token", { Authorization: `Bearer ${TOKEN.slice(0, -1)}` }],
    ["the wrong scheme", { Authorization: `Basic ${TOKEN}` }],
    ["a bare token", { Authorization: TOKEN }],
    ["an empty bearer", { Authorization: "Bearer " }],
  ])("rejects %s", async (_label, headers) => {
    await expect401(await send(real, "InMemory/accounts/welcome", welcome, "application/json", headers));
    await expect401(await list(real, headers));
    expect(sent).toHaveLength(0);
  });

  it("accepts the token with any casing of the scheme", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const res = await send(real, "InMemory/accounts/welcome", welcome, "application/json", { Authorization: `${scheme} ${TOKEN}` });
      expect(res.status, scheme).toBe(200);
    }
  });

  it("authenticates before anything else, so callers learn nothing without the token", async () => {
    for (const p of ["Nope/accounts/welcome", "InMemory/accounts/nope", "..%2FInMemory/accounts/welcome", "NeedsConfig/accounts/welcome"]) {
      await expect401(await send(real, p, "{not json}", "application/json", {}));
      await expect401(await send(real, p, "x=1", "text/plain", {}));
    }
  });

  it("does not guard rendering, schemas or template listing", async () => {
    const render = await fetch(`${real.base}/v1/render/accounts/welcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(render.status).toBe(200);
    expect((await fetch(`${real.base}/v1/templates`)).status).toBe(200);
    expect((await fetch(`${real.base}/v1/schemas/accounts/welcome`)).status).toBe(200);
  });

  describe("when no usable token is configured, every sender request is rejected", () => {
    it.each([
      ["unset", {}],
      ["empty", { MAILJOT_TRANSPORT_AUTH_TOKEN: "" }],
      ["too short", { MAILJOT_TRANSPORT_AUTH_TOKEN: "short" }],
    ] as [string, Record<string, string>][])("with the token %s", async (_label, env) => {
      const app = await listen(templates, { transportsRoot, env });
      try {
        // Even a request that sends the same weak token (or an empty one) must not get in.
        const presented: Record<string, string>[] = "MAILJOT_TRANSPORT_AUTH_TOKEN" in env ? [{ Authorization: `Bearer ${env.MAILJOT_TRANSPORT_AUTH_TOKEN}` }, {}] : [{}];
        for (const headers of presented) {
          await expect401(await send(app, "InMemory/accounts/welcome", welcome, "application/json", headers));
          await expect401(await list(app, headers));
        }
        expect(sent).toHaveLength(0);
      } finally {
        await new Promise((r) => app.server.close(r));
      }
    });
  });
});

describe("the built-in Logging and Recording transports, through the real sender", () => {
  const realTransports = fileURLToPath(new URL("../transports", import.meta.url));
  const receipt = { customerName: "Z", orderNumber: "A-1", currency: "GBP", charges: [{ description: "W", quantity: 2, unitPriceCents: 250 }] };
  let recordings: string;
  let app: Running;
  let unconfigured: Running;

  beforeAll(async () => {
    recordings = await mkdtemp(path.join(os.tmpdir(), "mailjot-e2e-recordings-"));
    app = await listen(templates, { transportsRoot: realTransports, env: { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN, RECORDING_DIR: recordings } });
    unconfigured = await listen(templates, { transportsRoot: realTransports });
  });
  afterAll(async () => {
    await Promise.all([app, unconfigured].map((a) => new Promise((r) => a.server.close(r))));
    await rm(recordings, { recursive: true, force: true });
  });

  it("lists them, with Mailjet unavailable until it has credentials", async () => {
    const body = await (await list(app)).json();
    const byName = Object.fromEntries(body.transports.map((t: { name: string }) => [t.name, t]));
    expect(Object.keys(byName).sort()).toEqual(["BlackHole", "Logging", "Mailjet", "Recording"]);
    expect(byName.BlackHole).toMatchObject({ available: true, options: { properties: {}, additionalProperties: false } });
    expect(byName.Logging).toMatchObject({ available: true, options: { properties: { label: expect.anything() } } });
    expect(byName.Recording).toMatchObject({ available: true, options: { properties: { tag: expect.anything() } } });
    expect(byName.Mailjet).toEqual({ name: "Mailjet", available: false });
  });

  it("Logging writes one JSON line and reports success", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await send(app, "logging/accounts/welcome", { ...welcome, options: { label: "e2e" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ transport: "Logging", template: "accounts/welcome", subject: "Welcome aboard, Alice!", response: { logged: true } });

    const line = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes(body.messageId))!;
    expect(JSON.parse(line)).toMatchObject({ event: "mailjot.message", label: "e2e", envelope, template: "accounts/welcome" });
  });

  it("BlackHole swallows the message and says exactly how much it swallowed", async () => {
    const before = await readdir(recordings);

    // The real rendered email, to count independently of the transport.
    const rendered = await (
      await fetch(`${app.base}/v1/render/billing/receipt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(receipt),
      })
    ).json();
    const characters = [...rendered.html].length + [...rendered.text].length;
    const lineCount = (t: string) => t.split(/\r\n|\r|\n/).length - (t.endsWith("\n") || t.endsWith("\r") ? 1 : 0);
    const lines = lineCount(rendered.html) + lineCount(rendered.text);

    logs.reset();
    const res = await send(app, "blackhole/billing/receipt", { envelope, input: receipt });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transport: "BlackHole",
      template: "billing/receipt",
      version: "1.0.0",
      subject: "Your receipt for order A-1",
      response: { swallowed: true, characters, lines },
    });
    // The transport logs through the engine's logger, so its line carries the request ID and what it was handling.
    const [swallowed] = logs.lines().filter((l) => l.event === "mailjot.transport.blackhole.swallowed");
    expect(swallowed).toMatchObject({
      level: "info",
      msg: `Swallowed ${characters} characters on ${lines} lines!`,
      characters,
      lines,
      transport: "BlackHole",
      template: "billing/receipt",
      api_version: "v1",
      request_id: logs.lines().find((l) => l.event === "mailjot.request")!.request_id,
    });
    expect(await readdir(recordings)).toEqual(before);
  });

  it("BlackHole is never silent, and rejects options and invalid requests like any transport", async () => {
    logs.reset();
    expect((await send(app, "BlackHole/accounts/welcome", welcome)).status).toBe(200);
    expect((await send(app, "BlackHole/accounts/welcome", welcome)).status).toBe(200);
    const swallowed = () => logs.lines().filter((l) => l.event === "mailjot.transport.blackhole.swallowed").length;
    expect(swallowed()).toBe(2);

    const withOptions = await send(app, "BlackHole/accounts/welcome", { ...welcome, options: { sneaky: true } });
    expect(withOptions.status).toBe(400);
    expect((await withOptions.json()).error).toBe("invalid_options");
    expect((await send(app, "BlackHole/accounts/welcome", { envelope, input: {} })).status).toBe(400);
    expect((await send(app, "BlackHole/accounts/welcome", { ...welcome, dryRun: true })).status).toBe(200);
    expect(swallowed()).toBe(2); // rejected requests and dry runs swallow nothing
  });

  it("Recording saves the rendered email, and the id returned names the directory", async () => {
    const res = await send(app, "Recording/billing/receipt", {
      envelope,
      options: { tag: "e2e" },
      input: { customerName: "Z", orderNumber: "A-1", currency: "GBP", charges: [{ description: "W", quantity: 2, unitPriceCents: 250 }] },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.subject).toBe("Your receipt for order A-1");

    const dir = path.join(recordings, body.messageId);
    expect(await readFile(path.join(dir, "message.html"), "utf8")).toContain("Total: £5.00");
    expect(await readFile(path.join(dir, "message.txt"), "utf8")).toContain("Total: £5.00");
    expect(JSON.parse(await readFile(path.join(dir, "message.json"), "utf8"))).toMatchObject({ tag: "e2e", subject: "Your receipt for order A-1", envelope });
    // The response names files relative to the recording, never a server path.
    expect(JSON.stringify(body)).not.toContain(recordings);
  });

  it("a dry run writes nothing", async () => {
    const before = await readdir(recordings);
    const res = await send(app, "Recording/accounts/welcome", { ...welcome, dryRun: true });
    expect((await res.json()).dryRun).toBe(true);
    expect(await readdir(recordings)).toEqual(before);
  });

  it("a request that fails validation records nothing", async () => {
    const before = await readdir(recordings);
    const res = await send(app, "Recording/accounts/welcome", { envelope, input: {} });
    expect(res.status).toBe(400);
    expect(await readdir(recordings)).toEqual(before);
  });

  it("Recording is unavailable (503) until RECORDING_DIR is set; Logging works without configuration", async () => {
    const rec = await send(unconfigured, "Recording/accounts/welcome", welcome);
    expect(rec.status).toBe(503);
    expect((await rec.json()).error.code).toBe("transport_unavailable");

    vi.spyOn(console, "log").mockImplementation(() => {});
    expect((await send(unconfigured, "Logging/accounts/welcome", welcome)).status).toBe(200);
  });
});

describe("transports added while the server is running", () => {
  // A transport directory that appears (or disappears) after startup is noticed on the next request. The routes
  // are decided per request, not once when the router is built, so starting with none is no different.
  const transportModule = (name: string) => `import { z } from "zod";
export const metadata = { id: ${JSON.stringify(name)}, description: "Added at runtime." };
export const config = z.object({});
export default async function send() {
  return { ok: true, messageId: "hot-1", response: { hot: true } };
}
`;
  let dir: string;
  let hot: string;
  let app: Running;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "mailjot-hot-"));
    // Bare imports in a transport written here (zod) resolve through this link to the project's dependencies.
    await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(dir, "node_modules"));
    hot = path.join(dir, "transports");
    await mkdir(path.join(hot, "v1"), { recursive: true }); // present, but empty
    app = await listen(templates, { transportsRoot: hot });
  });
  afterAll(async () => {
    await new Promise((r) => app.server.close(r));
    await rm(dir, { recursive: true, force: true });
  });

  it("starts with none: the sender routes answer as if they did not exist, even to an authenticated caller", async () => {
    for (const res of [await list(app), await send(app, "Hot/accounts/welcome", welcome)]) {
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    }
    // No credentials at all gets the same answer: nothing here reveals that a sender could exist.
    expect((await list(app, {})).status).toBe(404);
  });

  it("serves a transport as soon as it appears, with authentication applying from then on", async () => {
    await mkdir(path.join(hot, "v1", "Hot"));
    await writeFile(path.join(hot, "v1", "Hot", "transport.js"), transportModule("Hot"));

    const listed = await list(app);
    expect(listed.status).toBe(200);
    expect((await listed.json()).transports).toEqual([expect.objectContaining({ name: "Hot", available: true })]);

    const sentOk = await send(app, "hot/accounts/welcome", welcome);
    expect(sentOk.status).toBe(200);
    expect(await sentOk.json()).toMatchObject({ transport: "Hot", template: "accounts/welcome", messageId: "hot-1" });

    expect((await list(app, {})).status).toBe(401);
  });

  it("goes back to 404 when the last transport is removed", async () => {
    await rm(path.join(hot, "v1", "Hot"), { recursive: true });
    expect((await list(app)).status).toBe(404);
    expect((await send(app, "Hot/accounts/welcome", welcome)).status).toBe(404);
  });

  it("keeps rendering available throughout", async () => {
    const res = await fetch(`${app.base}/v1/render/accounts/welcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("delivery is opt-in", () => {
  it.each([
    ["no transports directory configured", () => noTransports],
    ["a transports directory with no files for the version", () => emptyTransports],
    // The default when nothing is mounted: TRANSPORTS_DIR points at a directory that is not there.
    ["a transports directory that does not exist", () => missingTransports],
  ])("mounts no sender routes with %s", async (_label, app) => {
    expect((await list(app())).status).toBe(404);
    const res = await send(app(), "InMemory/accounts/welcome", welcome);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
    expect(sent).toHaveLength(0);
  });

  it("starts and serves everything else when the transports directory does not exist", async () => {
    for (const [route, init] of [
      ["/v1/render/accounts/welcome", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Alice" }) }],
      ["/v1/templates", {}],
      ["/v1/schemas/accounts/welcome", {}],
      ["/", {}],
    ] as [string, RequestInit][]) {
      expect((await fetch(`${missingTransports.base}${route}`, init)).status, route).toBe(200);
    }
  });

  it("still serves rendering when delivery is off", async () => {
    const res = await fetch(`${noTransports.base}/v1/render/accounts/welcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("sender logging", () => {
  const events = (name: string) => logs.lines().filter((l) => l.event === name);

  it("logs a successful send with the transport, template, message id and duration", async () => {
    logs.reset();
    const body = await (await send(real, "InMemory/accounts/welcome", welcome)).json();

    expect(events("mailjot.send.ok")).toEqual([
      expect.objectContaining({
        level: "info",
        api_version: "v1",
        transport: "InMemory",
        template: "accounts/welcome",
        message_id: body.messageId,
        dry_run: false,
        duration_ms: expect.any(Number),
      }),
    ]);
  });

  it("marks a dry run as one, with no message id", async () => {
    logs.reset();
    await send(real, "InMemory/accounts/welcome", { ...welcome, dryRun: true });

    const [line] = events("mailjot.send.ok");
    expect(line).toMatchObject({ dry_run: true, transport: "InMemory", template: "accounts/welcome" });
    expect(line).not.toHaveProperty("message_id");
  });

  it("logs a failed send with the transport, template and reason, but not the provider's message or response", async () => {
    logs.reset();
    const res = await send(real, "Failing/accounts/welcome", welcome);
    expect(res.status).toBe(502);

    expect(events("mailjot.send.failed")).toEqual([
      expect.objectContaining({ level: "error", transport: "Failing", template: "accounts/welcome", reason: "rejected" }),
    ]);
    expect(events("mailjot.send.ok")).toEqual([]);
    expect(logs.raw().join("")).not.toContain("mailbox does not exist");
    expect(logs.raw().join("")).not.toContain("550");
  });

  it("logs an integrity failure once, as a render failure with its code and detail", async () => {
    logs.reset();
    await send(broken, "InMemory/accounts/leaky", { envelope, input: { name: "Alice" } });

    const failures = events("mailjot.render.failed");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ level: "error", template: "accounts/leaky", code: "integrity_failed", detail: expect.stringContaining("unresolved undefined") });
  });

  it("does not log caller mistakes: bad input, bad envelope, unknown names", async () => {
    logs.reset();
    await send(real, "InMemory/accounts/welcome", { envelope, input: { wrong: 1 } }); // validation
    await send(real, "InMemory/accounts/welcome", { envelope: { to: [] }, input: { name: "Alice" } }); // envelope
    await send(real, "InMemory/accounts/welcome", { nonsense: true }); // request shape
    await send(real, "Nope/accounts/welcome", welcome); // unknown transport
    await send(real, "InMemory/accounts/nope", welcome); // unknown template

    // Nothing for the operator to act on: no event of its own. The access lines record that each was refused.
    const lines = logs.lines();
    expect(lines.filter((l) => l.event !== "mailjot.request")).toEqual([]);
    expect(lines.map((l) => l.status)).toEqual([400, 400, 400, 404, 404]);
  });

  describe("authentication", () => {
    it("logs a rejection when no credential is presented, saying so, and does nothing else", async () => {
      logs.reset();
      const res = await send(real, "InMemory/accounts/welcome", welcome, "application/json", {});
      expect(res.status).toBe(401);

      const lines = logs.lines();
      const rejected = lines.filter((l) => l.event === "mailjot.auth.rejected");
      expect(rejected).toEqual([
        expect.objectContaining({ level: "warn", api_version: "v1", route: "/sender", method: "POST", credential_presented: false }),
      ]);
      // Besides the access line for the same request, nothing else was logged.
      expect(lines.filter((l) => l.event !== "mailjot.auth.rejected")).toEqual([
        expect.objectContaining({ event: "mailjot.request", status: 401, request_id: rejected[0]!.request_id }),
      ]);
      expect(sent).toHaveLength(0);
    });

    it("logs a rejection for a wrong credential without the credential, and without the client address", async () => {
      logs.reset();
      const wrong = "Bearer wrong-token-value-0123456789";
      const res = await list(real, { Authorization: wrong });
      expect(res.status).toBe(401);

      const [line] = events("mailjot.auth.rejected");
      expect(line).toMatchObject({ credential_presented: true, method: "GET" });
      const raw = logs.raw().join("");
      expect(raw).not.toContain("wrong-token-value");
      expect(raw).not.toContain(TOKEN);
      expect(raw).not.toMatch(/127\.0\.0\.1|::1|::ffff/);
    });

    it("does not log anything for an accepted request's authentication", async () => {
      logs.reset();
      await list(real);
      expect(events("mailjot.auth.rejected")).toEqual([]);
    });
  });

  describe("startup", () => {
    const start = async (env: Record<string, string | undefined>) => {
      const captured = captureLogger();
      const { server } = await listen(templates, { transportsRoot, env, logger: captured.logger });
      await new Promise((r) => server.close(r));
      return captured.lines();
    };

    it("says authentication is required, and what each transport's status is", async () => {
      const lines = await start({ MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN });

      expect(lines.filter((l) => l.event === "mailjot.sender.ready")).toEqual([expect.objectContaining({ level: "info", api_version: "v1", auth: "required" })]);
      const status = Object.fromEntries(lines.filter((l) => l.event === "mailjot.transport.status").map((l) => [l.transport, l]));
      expect(Object.keys(status).sort()).toEqual(["Broken", "Failing", "InMemory", "NeedsConfig"]);
      expect(status.InMemory).toMatchObject({ level: "info", available: true });
      expect(status.InMemory).not.toHaveProperty("problems");
      expect(status.NeedsConfig).toMatchObject({ available: false, problems: [expect.stringContaining("NEEDS_CONFIG_TOKEN")] });
      expect(JSON.stringify(lines)).not.toContain(TOKEN);
    });

    it("warns, with the reason, when authentication is disabled because no usable token is configured", async () => {
      for (const [env, reason] of [
        [{}, "is not set"],
        [{ MAILJOT_TRANSPORT_AUTH_TOKEN: "short" }, "shorter than"],
      ] as const) {
        const [ready] = (await start(env)).filter((l) => l.event === "mailjot.sender.ready");
        expect(ready).toMatchObject({ level: "warn", auth: "disabled" });
        expect(ready!.reason).toContain(reason);
        expect(JSON.stringify(ready)).not.toContain("short\"");
      }
    });

    it("says nothing about the sender when there are no transports", async () => {
      const captured = captureLogger();
      const { server } = await listen(templates, { logger: captured.logger });
      await new Promise((r) => server.close(r));
      expect(captured.lines().filter((l) => String(l.event).startsWith("mailjot.sender") || String(l.event).startsWith("mailjot.transport"))).toEqual([]);
    });
  });

  it("never writes a recipient, a subject, a body, a credential or a provider response to the log", async () => {
    logs.reset();
    // Every path that logs: success, dry run, rejection, render failure, integrity failure, bad credential, unavailable transport.
    await send(real, "InMemory/accounts/welcome", welcome);
    await send(real, "InMemory/accounts/welcome", { ...welcome, dryRun: true });
    await send(real, "Failing/accounts/welcome", welcome);
    await send(real, "NeedsConfig/accounts/welcome", welcome);
    await send(real, "Broken/accounts/welcome", welcome);
    await send(broken, "InMemory/accounts/broken", { envelope, input: { name: "Alice" } });
    await send(broken, "InMemory/accounts/leaky", { envelope, input: { name: "Alice" } });
    await send(real, "InMemory/accounts/welcome", welcome, "application/json", { Authorization: "Bearer not-the-token-0123456789" });

    expect(logs.lines().length).toBeGreaterThan(5);
    const raw = logs.raw().join("");
    for (const value of ["alice@example.com", "billing@example.com", "Welcome aboard, Alice!", TOKEN, "not-the-token", "mailbox does not exist", "<!DOCTYPE", "<html", "Alice"]) {
      expect(raw, value).not.toContain(value);
    }
  });
});
