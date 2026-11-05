import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { loadVersionRouters, type VersionContext } from "./router.js";
import { captureLogger } from "../test/captureLogger.js";

const root = fileURLToPath(new URL("../templates", import.meta.url));
const fixturesRoot = fileURLToPath(new URL("../test/fixtures/templates", import.meta.url));

/** What the shared servers log; a test calls `logs.reset()` first, then reads only its own lines. */
const logs = captureLogger();

async function listen(templatesRoot: string, extra: { env?: Record<string, string | undefined> } = {}): Promise<{ server: Server; base: string }> {
  const server = (await createApp(templatesRoot, { logger: logs.logger, ...extra })).listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

let server: Server;
let base: string;
let fixtures: { server: Server; base: string };

beforeAll(async () => {
  ({ server, base } = await listen(root));
  fixtures = await listen(fixturesRoot);
});
afterAll(async () => {
  await Promise.all([server, fixtures.server].map((s) => new Promise((r) => s.close(r))));
});

const post = (p: string, body: string, contentType = "application/json") =>
  fetch(base + p, { method: "POST", headers: { "Content-Type": contentType }, body });

describe("GET /healthz", () => {
  it("reports ok", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("GET /v1/templates", () => {
  it("lists available templates", async () => {
    const res = await fetch(`${base}/v1/templates`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.templates).toContainEqual({
      template: "accounts/welcome",
      version: "1.0.0",
      description: "Welcome email sent to new accounts.",
    });
  });
});

describe("GET /v1/schemas/*", () => {
  it("returns the schema for a nested tempate", async () => {
    const res = await fetch(`${base}/v1/schemas/accounts/welcome`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.template).toBe("accounts/welcome");
    expect(body.jsonSchema.required).toEqual(["name"]);
    expect(body.examples.default).toEqual({ name: "Alice" });
  });

  it("404s for traversal attempts on the schema route", async () => {
    for (const p of ["..%2F..%2Fpackage.json", "%2e%2e/%2e%2e/etc/passwd", "accounts%5Cwelcome", "accounts/welcome%00"]) {
      const res = await fetch(`${base}/v1/schemas/${p}`);
      expect(res.status, p).toBe(404);
    }
  });

  it("404s for an unknown template", async () => {
    const res = await fetch(`${base}/v1/schemas/accounts/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("template_not_found");
  });
});

describe("POST /v1/render/*", () => {
  it("renders a valid payload", async () => {
    const res = await post("/v1/render/accounts/welcome", JSON.stringify({ name: "Alice" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ template: "accounts/welcome", version: "1.0.0", subject: "Welcome aboard, Alice!" });
    expect(body.html).toContain("<!DOCTYPE html");
    expect(body.text).toContain("Welcome aboard, Alice!");
  });

  it("returns 422 with field errors for an invalid payload", async () => {
    const res = await post("/v1/render/accounts/welcome", JSON.stringify({ name: 1, extra: true }));
    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual([
      { path: ["name"], code: "invalid_type", message: expect.any(String) },
      { path: ["extra"], code: "unrecognized_keys", message: expect.any(String) },
    ]);
  });

  it("returns 422 for an empty-object payload missing required fields", async () => {
    const res = await post("/v1/render/accounts/welcome", "{}");
    expect(res.status).toBe(422);
  });

  it("returns 404 for unknown and malicious template paths", async () => {
    for (const p of ["accounts/nope", "..%2F..%2Fpackage.json", "%2e%2e/%2e%2e/etc/passwd", "accounts/welcome/"]) {
      const res = await post(`/v1/render/${p}`, "{}");
      expect(res.status, p).toBe(404);
    }
  });

  it("returns a generic 500 when rendering fails", async () => {
    logs.reset();
    const res = await fetch(`${fixtures.base}/v1/render/accounts/broken`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text).error).toEqual({ code: "render_failed", message: "Failed to render template" });
    expect(text).not.toContain("secret");
    expect(logs.lines()).toContainEqual(
      expect.objectContaining({ level: "error", event: "mailjot.render.failed", api_version: "v1", template: "accounts/broken", code: "render_failed" }),
    );
  });

  it("returns 400 for malformed JSON", async () => {
    const res = await post("/v1/render/accounts/welcome", "{nope");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
  });

  it("returns 415 for a non-JSON content type", async () => {
    const res = await post("/v1/render/accounts/welcome", "name=Alice", "text/plain");
    expect(res.status).toBe(415);
  });

  it("returns 413 for an oversized body", async () => {
    const res = await post("/v1/render/accounts/welcome", JSON.stringify({ name: "x".repeat(2_000_000) }));
    expect(res.status).toBe(413);
  });
});

describe("a template that cannot be served", () => {
  const renderOf = (id: string) =>
    fetch(`${fixtures.base}/v1/render/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });

  it("answers a contract violation with a generic 500 on every route that loads it, and logs the cause", async () => {
    logs.reset();
    {
      for (const res of [
        await renderOf("accounts/malformed"),
        await fetch(`${fixtures.base}/v1/schemas/accounts/malformed`),
      ]) {
        const text = await res.text();
        expect(res.status).toBe(500);
        expect(JSON.parse(text)).toEqual({ error: { code: "template_unavailable", message: "Template is unavailable" } });
        // Neither the module's contents nor the list of what is wrong with it reaches the caller.
        expect(text).not.toContain("secret-contract-detail");
        expect(text).not.toMatch(/metadata|schema|violates/);
      }
      // The operator gets the real reason, including every problem found.
      const violations = logs.lines().filter((l) => l.event === "mailjot.template.contract_violation");
      expect(violations).toHaveLength(2);
      for (const line of violations) {
        expect(line).toMatchObject({ level: "error", template: "accounts/malformed" });
        expect(line.msg).toContain("violates the contract");
        expect((line.problems as string[]).join("\n")).toContain("`metadata.version` must be");
      }
    }
  });

  it("is left out of the template listing, with a log line, without hiding the healthy templates", async () => {
    logs.reset();
    {
      const res = await fetch(`${fixtures.base}/v1/templates`);
      expect(res.status).toBe(200);
      const ids = ((await res.json()).templates as { template: string }[]).map((d) => d.template);
      expect(ids).not.toContain("accounts/malformed");
      expect(ids).toEqual(expect.arrayContaining(["accounts/broken", "accounts/explosive", "accounts/hung", "accounts/leaky"]));
      const skipped = logs.lines().filter((l) => l.event === "mailjot.template.unloadable");
      expect(skipped).toHaveLength(1);
      expect(skipped[0]).toMatchObject({ level: "warn", template: "accounts/malformed", err: { type: "TemplateContractError" } });
      expect((skipped[0]!.problems as string[]).join("\n")).toContain("`metadata.version` must be");
    }
  });

  it("answers an unexpected exception during validation with a generic 500, leaking nothing", async () => {
    logs.reset();
    {
      const res = await renderOf("accounts/explosive");
      const text = await res.text();
      expect(res.status).toBe(500);
      expect(JSON.parse(text)).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
      expect(text).not.toContain("secret");
      expect(text).not.toContain("/srv/app");
      // It is logged, so the failure is not silent.
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({
          level: "error",
          event: "mailjot.error.unhandled",
          err: expect.objectContaining({ message: "secret internal detail at /srv/app/db" }),
        }),
      );
    }
  });
});

describe("dependencies inside the templates directory", () => {
  // If a node_modules ever ends up inside a templates version directory, a request must not be able to
  // reach it: importing a package's entry file runs that package's code, and the status code (404 or 500)
  // would reveal which packages are installed.
  it("never imports or reveals a package, however it is requested", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mailjot-nodemodules-"));
    const flag = "__mailjotImportedFromNodeModules";
    await mkdir(path.join(dir, "v1", "node_modules", "some-package"), { recursive: true });
    await writeFile(path.join(dir, "v1", "node_modules", "some-package", "index.js"), `globalThis.${flag} = true; export const metadata = {};\n`);
    await mkdir(path.join(dir, "v1", "accounts", "node_modules", "dep"), { recursive: true });
    await writeFile(path.join(dir, "v1", "accounts", "node_modules", "dep", "index.js"), `globalThis.${flag} = true; export {};\n`);

    const app = await listen(dir);
    try {
      const unknown = await fetch(`${app.base}/v1/render/accounts/does-not-exist`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      const expected = { status: unknown.status, body: await unknown.json() };
      expect(expected.status).toBe(404);

      for (const requested of ["node_modules/some-package", "accounts/node_modules/dep", "Node_Modules/some-package"]) {
        for (const [method, route] of [["POST", "render"], ["GET", "schemas"]] as const) {
          const res = await fetch(`${app.base}/v1/${route}/${requested}`, {
            method,
            headers: { "Content-Type": "application/json" },
            ...(method === "POST" ? { body: "{}" } : {}),
          });
          // Indistinguishable from any other unknown template.
          expect({ status: res.status, body: await res.json() }, `${method} ${route}/${requested}`).toEqual(expected);
        }
      }
      expect((await (await fetch(`${app.base}/v1/templates`)).json()).templates).toEqual([]);
      expect((globalThis as Record<string, unknown>)[flag]).toBeUndefined();
    } finally {
      await new Promise((r) => app.server.close(r));
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("body problems the parser reports beyond bad JSON and size", () => {
  // The code for these is `bad_request` with a generic message. (An unknown Content-Encoding is a 415,
  // while the documented 415 code is `unsupported_media_type`; this pins today's behavior.)
  const withHeaders = (headers: Record<string, string>, body: string) =>
    fetch(`${base}/v1/render/accounts/welcome`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });

  it("rejects a body that claims to be gzip but is not, with a generic 400", async () => {
    const res = await withHeaders({ "Content-Encoding": "gzip" }, '{"name":"Alice"}');
    const text = await res.text();
    expect(res.status).toBe(400);
    expect(JSON.parse(text)).toEqual({ error: { code: "bad_request", message: "Bad request" } });
    expect(text).not.toMatch(/zlib|incorrect header|Z_DATA_ERROR|stack/i);
  });

  it("rejects an unknown Content-Encoding with a generic 415", async () => {
    const res = await withHeaders({ "Content-Encoding": "weird" }, '{"name":"Alice"}');
    const text = await res.text();
    expect(res.status).toBe(415);
    expect(JSON.parse(text)).toEqual({ error: { code: "bad_request", message: "Bad request" } });
    expect(text).not.toContain("weird");
  });

  it("serves the same request without the encoding header", async () => {
    expect((await withHeaders({}, '{"name":"Alice"}')).status).toBe(200);
  });
});

describe("the engine's last-resort error handling", () => {
  // A version router is free to omit its own error handling (the v1 router has one). Whatever it does,
  // the engine must still answer with a generic JSON 500 and log the cause.
  it("answers errors from a router with no handler of its own with a generic 500, sync or async", async () => {
    const captured = captureLogger();
    const dir = await mkdtemp(path.join(os.tmpdir(), "mailjot-lastresort-"));
    await mkdir(path.join(dir, "v1"));
    try {
      const router = async () => {
        const r = express.Router();
        r.get("/boom", () => {
          throw new Error("secret internal detail");
        });
        r.get("/boom-async", async () => {
          throw new Error("secret internal detail");
        });
        return r;
      };
      const app = (await createApp(dir, { routers: { 1: router }, logger: captured.logger })).listen(0);
      await new Promise((r) => app.once("listening", r));
      try {
        const url = `http://127.0.0.1:${(app.address() as AddressInfo).port}`;
        for (const route of ["/v1/boom", "/v1/boom-async"]) {
          const res = await fetch(url + route);
          const text = await res.text();
          expect(res.status, route).toBe(500);
          expect(res.headers.get("content-type")).toContain("application/json");
          expect(JSON.parse(text), route).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
          expect(text).not.toContain("secret");
        }
        // The cause is logged (message and stack) for the operator, once per failed request, and never sent to the caller.
        const unhandled = captured.lines().filter((l) => l.event === "mailjot.error.unhandled");
        expect(unhandled).toHaveLength(2);
        for (const line of unhandled) {
          expect(line).toMatchObject({ level: "error", err: { type: "Error", message: "secret internal detail" } });
        }
      } finally {
        await new Promise((r) => app.close(r));
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("render timeout", () => {
  const renderHung = (base: string) =>
    fetch(`${base}/v1/render/accounts/hung`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Alice" }),
    });

  it("applies RENDER_TIMEOUT_MS from the environment, ending a hung render with a generic 500", async () => {
    logs.reset();
    const app = await listen(fixturesRoot, { env: { RENDER_TIMEOUT_MS: "150" } });
    try {
      const started = Date.now();
      const res = await renderHung(app.base);
      expect(res.status).toBe(500);
      expect((await res.json()).error).toEqual({ code: "render_failed", message: "Failed to render template" });
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(logs.lines()).toContainEqual(
        expect.objectContaining({ event: "mailjot.render.failed", template: "accounts/hung", code: "render_failed", err: expect.objectContaining({ cause: expect.objectContaining({ message: "render timed out after 150ms" }) }) }),
      );
    } finally {
      await new Promise((r) => app.server.close(r));
    }
  });
});

describe("versioning", () => {
  it("lists the mounted versions at /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ versions: ["v1"] });
  });

  it("returns a JSON 404 for an unmounted version", async () => {
    for (const p of ["/v2/template", "/v9/render/accounts/welcome", "/v0/template"]) {
      const res = await fetch(base + p);
      expect(res.status, p).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    }
  });

  it("returns a JSON 404 for an unknown route inside a version", async () => {
    const res = await fetch(`${base}/v1/nope`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});

describe("startup from the directory layout", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), "mailjot-versions-"));
  });
  afterAll(() => rm(tmp, { recursive: true, force: true }));

  const layout = async (name: string, dirs: string[]) => {
    const root = path.join(tmp, name);
    await mkdir(root, { recursive: true });
    for (const d of dirs) await mkdir(path.join(root, d), { recursive: true });
    return root;
  };

  it("fails when a version directory has no router implementation", async () => {
    const root = await layout("unimplemented", ["v1", "v2"]);
    await expect(createApp(root)).rejects.toThrow(/"v2".*no router implementation/);
  });

  it("names the implemented versions in the startup error, or says there are none", async () => {
    const root = await layout("none-implemented", ["v1"]);
    await expect(createApp(root, { routers: {} })).rejects.toThrow(/Implemented versions: none/);
    await expect(createApp(root, { routers: { 2: async () => express.Router() } })).rejects.toThrow(/Implemented versions: v2/);
  });

  it("fails with a hint when template are not in a version directory", async () => {
    const root = await layout("legacy", ["accounts/welcome"]);
    const captured = captureLogger();
    await expect(createApp(root, { logger: captured.logger })).rejects.toThrow(/No version directories.*v1/);
    expect(captured.lines()).toContainEqual(
      expect.objectContaining({ level: "warn", event: "mailjot.versions.ignored", directory: "accounts", root }),
    );
  });

  it("logs a non-version directory next to real versions, and still starts", async () => {
    const root = await layout("with-static", ["v1", "static"]);
    const captured = captureLogger();
    const app = await createApp(root, { routers: { 1: async () => express.Router() }, logger: captured.logger });
    expect(app).toBeDefined();
    expect(captured.lines().filter((l) => l.event === "mailjot.versions.ignored")).toEqual([
      expect.objectContaining({ level: "warn", directory: "static" }),
    ]);
  });

  it("hands each router its own version's directories and lets it resolve the rest", async () => {
    const root = await layout("dispatch", ["templates/v1", "templates/v2"]);
    const templates = path.join(root, "templates");
    const transports = path.join(root, "transports");
    const seen: { version: unknown; templatesDir: string; transportsDir: string | undefined; env: unknown }[] = [];
    const captured = captureLogger();
    const record = (label: string) => async (ctx: VersionContext) => {
      seen.push({ version: ctx.version, templatesDir: ctx.templatesDir, transportsDir: ctx.transportsDir, env: ctx.env });
      ctx.logger.info({ event: "test.router", label }, "router created");
      const router = express.Router();
      router.get("/who", (_req, res) => void res.json({ label }));
      return router;
    };
    const env = { MARKER: "x" };
    const app = await createApp(templates, { routers: { 1: record("one"), 2: record("two") }, transportsRoot: transports, env, logger: captured.logger });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(`${base}/v1/who`)).json()).toEqual({ label: "one" });
      expect(await (await fetch(`${base}/v2/who`)).json()).toEqual({ label: "two" });
    } finally {
      await new Promise((r) => server.close(r));
    }

    // Each router gets a logger scoped to its own version.
    expect(captured.lines().filter((l) => l.event === "test.router")).toEqual([
      expect.objectContaining({ label: "one", api_version: "v1" }),
      expect.objectContaining({ label: "two", api_version: "v2" }),
    ]);

    expect(seen).toEqual([
      { version: { name: "v1", number: 1 }, templatesDir: path.join(templates, "v1"), transportsDir: path.join(transports, "v1"), env },
      { version: { name: "v2", number: 2 }, templatesDir: path.join(templates, "v2"), transportsDir: path.join(transports, "v2"), env },
    ]);
  });

  it("passes no transports directory when none is configured", async () => {
    const root = await layout("no-transports", ["v1"]);
    let transportsDir: string | undefined = "unset";
    const app = await createApp(root, {
      routers: {
        1: async (ctx) => {
          transportsDir = ctx.transportsDir;
          return express.Router();
        },
      },
    });
    expect(app).toBeDefined();
    expect(transportsDir).toBeUndefined();
  });

  it("mounts every version that has an implementation", async () => {
    const root = await layout("both", ["v1", "v2"]);
    const { 1: v1 } = await loadVersionRouters();
    const app = await createApp(root, { routers: { 1: v1!, 2: v1! }, logger: logs.logger });
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      expect(await res.json()).toEqual({ versions: ["v1", "v2"] });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("unknown routes", () => {
  it("return a JSON 404", async () => {
    const res = await fetch(`${base}/v2/whatever`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });
});
