import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { captureLogger } from "../test/captureLogger.js";
import { sent } from "../test/fixtures/transports/v1/InMemory/transport.js";
import { createApp } from "./app.js";
import { createRouter } from "./routers/v1/router.js";

const templates = fileURLToPath(new URL("../templates", import.meta.url));
const fixtureTemplates = fileURLToPath(new URL("../test/fixtures/templates", import.meta.url));
const transportsRoot = fileURLToPath(new URL("../test/fixtures/transports", import.meta.url));

const TOKEN = "test-sender-token-0123456789";
const envelope = { from: { email: "billing@example.com", name: "Billing" }, to: [{ email: "alice@example.com", name: "Alice" }] };

let generated = 0;
const generateRequestId = () => `gen-${++generated}`;

interface Running {
  server: Server;
  base: string;
  logs: ReturnType<typeof captureLogger>;
}

async function start(templatesRoot: string, level?: string): Promise<Running> {
  const logs = captureLogger(level ? { LOG_LEVEL: level } : {});
  const app = await createApp(templatesRoot, {
    transportsRoot,
    env: { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN },
    logger: logs.logger,
    generateRequestId,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs };
}

let real: Running;
let broken: Running;
let debug: Running;

beforeAll(async () => {
  [real, broken, debug] = await Promise.all([start(templates), start(fixtureTemplates), start(templates, "debug")]);
});
afterAll(async () => {
  await Promise.all([real, broken, debug].map((r) => new Promise((res) => r.server.close(res))));
});
beforeEach(() => {
  generated = 0;
  sent.length = 0;
  for (const r of [real, broken, debug]) r.logs.reset();
});

const post = (app: Running, p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${app.base}${p}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const requests = (app: Running) => app.logs.lines().filter((l) => l.event === "mailjot.request");

describe("request ID", () => {
  it("generates one when the caller sends none, sets it on the response and uses it in the log", async () => {
    const res = await post(real, "/v1/render/accounts/welcome", { name: "Alice" });

    expect(res.headers.get("x-request-id")).toBe("gen-1");
    expect(requests(real)).toEqual([expect.objectContaining({ request_id: "gen-1" })]);
  });

  it.each(["abc123", "A.b_c-1", "a".repeat(64), "0f8fad5b-d9cb-469f-a165-70867728950e"])("echoes a safe ID from the caller: %s", async (id) => {
    const res = await post(real, "/v1/render/accounts/welcome", { name: "Alice" }, { "X-Request-Id": id });

    expect(res.headers.get("x-request-id")).toBe(id);
    expect(requests(real)[0]).toMatchObject({ request_id: id });
    expect(generated).toBe(0);
  });

  it.each([["has a space", "a b"], ["too long", "a".repeat(65)], ["markup", "<script>alert(1)</script>"], ["a comma", "a,b"], ["a slash", "../x"], ["quotes", 'a"b'], ["empty", ""], ["json", '{"level":"error"}']])(
    "replaces an unsafe ID (%s) instead of echoing or logging it",
    async (_label, id) => {
      const res = await post(real, "/v1/render/accounts/welcome", { name: "Alice" }, { "X-Request-Id": id });

      expect(res.headers.get("x-request-id")).toBe("gen-1");
      expect(requests(real)[0]).toMatchObject({ request_id: "gen-1" });
      if (id !== "") expect(real.logs.raw().join("")).not.toContain(id.replaceAll('"', '\\"'));
    },
  );

  it("is on every response, including unknown routes and rejected sender requests", async () => {
    for (const [url, init] of [
      [`${real.base}/nothing`, {}],
      [`${real.base}/v1/nothing`, {}],
      [`${real.base}/v1/sender`, {}], // 401
      [`${real.base}/healthz`, {}],
      [`${real.base}/`, {}],
    ] as const) {
      const res = await fetch(url, init);
      expect(res.headers.get("x-request-id"), url).toMatch(/^gen-\d+$/);
    }
  });
});

describe("access line", () => {
  it("records the route pattern, status, duration, size and the resolved template", async () => {
    const res = await post(real, "/v1/render/accounts/welcome", { name: "Alice" });
    const body = await res.text();

    expect(requests(real)).toEqual([
      expect.objectContaining({
        level: "info",
        event: "mailjot.request",
        api_version: "v1",
        request_id: "gen-1",
        method: "POST",
        route: "/v1/render/*template",
        status: 200,
        duration_ms: expect.any(Number),
        bytes_out: Buffer.byteLength(body),
        template: "accounts/welcome",
        msg: "POST /v1/render/*template 200",
      }),
    ]);
  });

  it("records the transport and template of a send", async () => {
    await post(real, "/v1/sender/InMemory/accounts/welcome", { envelope, input: { name: "Alice" } }, { Authorization: `Bearer ${TOKEN}` });

    expect(requests(real)).toEqual([
      expect.objectContaining({ route: "/v1/sender/:transport/*template", status: 200, transport: "InMemory", template: "accounts/welcome" }),
    ]);
  });

  it("logs the route pattern, never the URL: no query string, no raw path, and no name that did not resolve", async () => {
    await post(real, "/v1/render/accounts/nope?token=abc&x=1", {});
    await post(real, "/v1/render/..%2F..%2Fetc%2Fpasswd", {});
    await fetch(`${real.base}/v1/nothing/here?secret=hunter2`);

    const lines = requests(real);
    expect(lines.map((l) => [l.route, l.status])).toEqual([
      ["/v1/render/*template", 404],
      ["/v1/render/*template", 404],
      ["(unmatched)", 404],
    ]);
    expect(lines.every((l) => !("template" in l))).toBe(true);
    const raw = real.logs.raw().join("");
    for (const hostile of ["nope", "token=abc", "passwd", "etc", "nothing", "hunter2", "?"]) expect(raw, hostile).not.toContain(hostile);
  });

  it("does not log request headers or bodies", async () => {
    await post(real, "/v1/render/accounts/welcome", { name: "Distinctive Body Value" }, { "X-Secret-Header": "header-secret-value", Authorization: "Bearer should-not-appear" });

    const raw = real.logs.raw().join("");
    for (const value of ["Distinctive Body Value", "header-secret-value", "should-not-appear", "application/json"]) expect(raw, value).not.toContain(value);
  });

  it("levels follow the status: 2xx info, 4xx warn, 5xx error", async () => {
    await post(real, "/v1/render/accounts/welcome", { name: "Alice" }); // 200
    await post(real, "/v1/render/accounts/welcome", { wrong: 1 }); // 422
    await fetch(`${real.base}/v1/nothing`); // 404
    await post(broken, "/v1/render/accounts/broken", { name: "Alice" }); // 500

    expect(requests(real).map((l) => [l.status, l.level])).toEqual([[200, "info"], [422, "warn"], [404, "warn"]]);
    expect(requests(broken).map((l) => [l.status, l.level])).toEqual([[500, "error"]]);
  });

  it("marks a request the router's middleware answered, or one nobody answered, as unmatched", async () => {
    await fetch(`${real.base}/v1/sender`); // 401 from the sender's authentication
    await fetch(`${real.base}/elsewhere`); // no such path

    const [auth, other] = requests(real);
    expect(auth).toMatchObject({ route: "(unmatched)", status: 401, api_version: "v1" });
    expect(other).toMatchObject({ route: "(unmatched)", status: 404 });
    expect(other).not.toHaveProperty("api_version"); // no version served it
  });

  it("logs the health check at debug only, so probes do not fill the log", async () => {
    await fetch(`${real.base}/healthz`);
    expect(real.logs.lines()).toEqual([]); // default level: info

    await fetch(`${debug.base}/healthz`);
    expect(requests(debug)).toEqual([expect.objectContaining({ level: "debug", route: "/healthz", status: 200 })]);
  });

  it("logs a method that is not a plain upper-case name as OTHER", async () => {
    // M-SEARCH is a real HTTP method that Node accepts, and its hyphen makes it unsafe to use as a log value as it is.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(`${real.base}/v1/templates`, { method: "M-SEARCH" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });

    expect(status).toBe(404);
    expect(requests(real)).toEqual([expect.objectContaining({ method: "OTHER", status: 404 })]);
    await fetch(`${real.base}/v1/templates`, { method: "OPTIONS" });
    expect(requests(real)[1]).toMatchObject({ method: "OPTIONS" });
  });

  it("leaves out bytes_out when the response length is not known up front", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mailjot-stream-"));
    await mkdir(path.join(root, "v1"));
    const streaming = captureLogger();
    const app = (
      await createApp(root, {
        logger: streaming.logger,
        routers: {
          1: async () => {
            const router = express.Router();
            router.get("/stream", (_req, res) => {
              res.write("first ");
              res.end("second");
            });
            return router;
          },
        },
      })
    ).listen(0);
    await new Promise((r) => app.once("listening", r));
    try {
      const res = await fetch(`http://127.0.0.1:${(app.address() as AddressInfo).port}/v1/stream`);
      expect(await res.text()).toBe("first second");

      const [line] = streaming.lines().filter((l) => l.event === "mailjot.request");
      expect(line).toMatchObject({ route: "/v1/stream", status: 200 });
      expect(line).not.toHaveProperty("bytes_out");
    } finally {
      await new Promise((r) => app.close(r));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is on error responses too: malformed JSON, and an unhandled 500", async () => {
    const bad = await fetch(`${real.base}/v1/render/accounts/welcome`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{nope" });
    const boom = await post(broken, "/v1/render/accounts/explosive", { name: "Alice" });

    expect([bad.status, boom.status]).toEqual([400, 500]);
    expect(bad.headers.get("x-request-id")).toBe(requests(real)[0]!.request_id);
    expect(boom.headers.get("x-request-id")).toBe(requests(broken)[0]!.request_id);
  });
});

describe("one request, one ID", () => {
  it("puts the same request_id on the access line and on every line the request's handlers write", async () => {
    const res = await post(real, "/v1/sender/Failing/accounts/welcome", { envelope, input: { name: "Alice" } }, { Authorization: `Bearer ${TOKEN}`, "X-Request-Id": "trace-me-1" });
    expect(res.status).toBe(502);

    const lines = real.logs.lines();
    expect(lines.map((l) => l.event).sort()).toEqual(["mailjot.request", "mailjot.send.failed"]);
    expect(lines.every((l) => l.request_id === "trace-me-1" && l.api_version === "v1")).toBe(true);
    expect(requests(real)[0]).toMatchObject({ status: 502, level: "error", transport: "Failing" });
  });

  it("covers rejected authentication too", async () => {
    await fetch(`${real.base}/v1/sender`, { headers: { Authorization: "Bearer wrong-wrong-wrong-0123", "X-Request-Id": "trace-auth" } });

    const lines = real.logs.lines();
    expect(lines.map((l) => l.event).sort()).toEqual(["mailjot.auth.rejected", "mailjot.request"]);
    expect(lines.every((l) => l.request_id === "trace-auth")).toBe(true);
  });

  it("keeps concurrent requests apart: each line carries its own request's ID", async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => {
      const id = `job-${i}`;
      const explosive = i % 2 === 1;
      return {
        id,
        template: explosive ? "accounts/explosive" : "accounts/broken",
        run: () => post(broken, `/v1/render/${explosive ? "accounts/explosive" : "accounts/broken"}`, { name: "Alice" }, { "X-Request-Id": id }),
      };
    });
    await Promise.all(jobs.map((j) => j.run()));

    const lines = broken.logs.lines();
    for (const job of jobs) {
      const mine = lines.filter((l) => l.request_id === job.id);
      expect(mine.map((l) => l.event).sort(), job.id).toEqual([
        job.template === "accounts/broken" ? "mailjot.render.failed" : "mailjot.error.unhandled",
        "mailjot.request",
      ]);
      expect(mine.find((l) => l.event === "mailjot.request"), job.id).toMatchObject({ template: job.template, status: 500 });
      const failed = mine.find((l) => l.event === "mailjot.render.failed");
      if (failed) expect(failed.template).toBe(job.template);
    }
    expect(lines).toHaveLength(jobs.length * 2);
  });
});

describe("a router mounted without the request log", () => {
  // The engine always mounts requestLog first, but a router may be used elsewhere (a test, a different app). It must
  // not fail, and it must still log, through the logger it was given at startup.
  it("works and logs through its own logger, without a request ID", async () => {
    const captured = captureLogger();
    const router = await createRouter({
      version: { name: "v1", number: 1 },
      templatesDir: fileURLToPath(new URL("../test/fixtures/templates/v1", import.meta.url)),
      transportsDir: fileURLToPath(new URL("../test/fixtures/transports/v1", import.meta.url)),
      env: { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN },
      logger: captured.logger,
    });
    const app = express();
    app.use("/v1", router);
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      // A router-level rejection, a skipped template in the listing, and a request that resolves a template.
      expect((await fetch(`${base}/v1/sender`)).status).toBe(401);
      expect((await fetch(`${base}/v1/templates`)).status).toBe(200);
      expect((await fetch(`${base}/v1/schemas/accounts/broken`)).status).toBe(200);

      const lines = captured.lines();
      expect(lines).toContainEqual(expect.objectContaining({ level: "warn", event: "mailjot.auth.rejected" }));
      expect(lines).toContainEqual(expect.objectContaining({ level: "warn", event: "mailjot.template.unloadable", template: "accounts/malformed" }));
      expect(lines.every((l) => !("request_id" in l))).toBe(true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
