import { execFile, execFileSync } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../test/captureLogger.js";
import { createApp } from "./app.js";

const run = promisify(execFile);
const templates = fileURLToPath(new URL("../templates", import.meta.url));
const transports = fileURLToPath(new URL("../transports", import.meta.url));
const senderScript = fileURLToPath(new URL("../scripts/sender", import.meta.url));
const senderDataFile = fileURLToPath(new URL("../scripts/sender-data.json", import.meta.url));
const renderScript = fileURLToPath(new URL("../scripts/render", import.meta.url));
const renderDataFile = fileURLToPath(new URL("../scripts/render-data.json", import.meta.url));

const TOKEN = "scripts-test-token-0123456789";

/** The app's log lines stay in memory; they would otherwise fill the test output. */
const logs = captureLogger();

let server: Server;
let base: string;

beforeAll(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  server = (await createApp(templates, { transportsRoot: transports, env: { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, logger: logs.logger })).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  vi.restoreAllMocks();
});

describe("scripts/sender-data.json", () => {
  it("is a valid sender body for the script's default template", async () => {
    const body = JSON.parse(await readFile(senderDataFile, "utf8"));
    expect(Object.keys(body).sort()).toEqual(["dryRun", "envelope", "input"]);
    expect(body.dryRun).toBe(false);

    // Both transports that need no setup accept it as-is, so the script works out of the box.
    for (const transport of ["Logging", "BlackHole"]) {
      const res = await fetch(`${base}/v1/sender/${transport}/accounts/welcome`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify(body),
      });
      expect(res.status, transport).toBe(200);
    }
  });
});

let hasCurl = true;
try {
  execFileSync("curl", ["--version"], { stdio: "ignore" });
} catch {
  hasCurl = false;
}

/** Runs a script with a clean environment, so nothing leaks in from the machine running the tests. */
async function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run("bash", [script, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", MAILJOT_URL: base, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}
const sender = (args: string[], env: Record<string, string> = {}) => runScript(senderScript, args, env);
const render = (args: string[], env: Record<string, string> = {}) => runScript(renderScript, args, env);

describe.skipIf(!hasCurl)("scripts/sender", () => {
  it("is executable", async () => {
    await expect(access(senderScript, constants.X_OK)).resolves.toBeUndefined();
  });

  it("calls the default transport and template with the shipped body", async () => {
    const { code, stdout, stderr } = await sender([], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN });
    expect(code).toBe(0);
    expect(stderr).toBe(`POST ${base}/v1/sender/Logging/accounts/welcome -> HTTP 200\n`);
    expect(JSON.parse(stdout)).toMatchObject({ transport: "Logging", template: "accounts/welcome", subject: "Welcome aboard, Alice!" });
  });

  it("takes the transport and template from options or from the environment", async () => {
    const viaOptions = await sender(["-T", "blackhole", "-t", "accounts/welcome"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN });
    expect(JSON.parse(viaOptions.stdout)).toMatchObject({ transport: "BlackHole", response: { swallowed: true } });

    const viaEnv = await sender([], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN, MAILJOT_TRANSPORT: "BlackHole" });
    expect(JSON.parse(viaEnv.stdout).transport).toBe("BlackHole");
  });

  it("sends the file given with -f", async () => {
    const dry = fileURLToPath(new URL("../test/fixtures/scripts/dry-run.json", import.meta.url));
    const { code, stdout } = await sender(["-T", "BlackHole", "-f", dry], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ dryRun: true });
  });

  it("exits 1 and still prints the response when the service says no", async () => {
    const wrongToken = await sender([], { MAILJOT_TRANSPORT_AUTH_TOKEN: "not-the-right-token-at-all" });
    expect(wrongToken.code).toBe(1);
    expect(wrongToken.stderr).toContain("HTTP 401");
    expect(JSON.parse(wrongToken.stdout).error.code).toBe("unauthorized");

    const unknown = await sender(["-T", "Nope"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN });
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("HTTP 404");

    // A body that does not fit the template: the flat 400 comes through.
    const mismatch = await sender(["-t", "billing/receipt"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN });
    expect(mismatch.code).toBe(1);
    expect(JSON.parse(mismatch.stdout)).toMatchObject({ error: "render_failed", sub_error: "validation_failed" });
  });

  it("exits 2 with a clear message for usage problems", async () => {
    for (const [args, env, message] of [
      [[], {}, "MAILJOT_TRANSPORT_AUTH_TOKEN is not set"],
      [["-f", "/no/such/file.json"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, "body file not found"],
      [["-x"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, "unknown option -x"],
      [["-t"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, "option -t needs a value"],
      [["-T"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, "option -T needs a value"],
      [["-d", "accounts/welcome"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, "unknown option -d"],
      [["stray"], { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN }, "unexpected argument 'stray'"],
    ] as [string[], Record<string, string>, string][]) {
      const result = await sender(args, env);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toContain(message);
    }
  });

  it("handles a token with quotes and backslashes, and never prints it", async () => {
    const odd = 'tok"en\\with-"quotes"-0123456789';
    const odder = await (async () => {
      const app = (await createApp(templates, { transportsRoot: transports, env: { MAILJOT_TRANSPORT_AUTH_TOKEN: odd }, logger: logs.logger })).listen(0);
      await new Promise((r) => app.once("listening", r));
      return app;
    })();
    try {
      const url = `http://127.0.0.1:${(odder.address() as AddressInfo).port}`;
      const result = await sender([], { MAILJOT_TRANSPORT_AUTH_TOKEN: odd, MAILJOT_URL: url });
      expect(result.code).toBe(0);
      expect(result.stdout + result.stderr).not.toContain("tok");
    } finally {
      await new Promise((r) => odder.close(r));
    }
  });

  it("prints its documentation with -h", async () => {
    const { code, stdout } = await sender(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("-T TRANSPORT");
    expect(stdout).toContain("-t TEMPLATE");
    expect(stdout).toContain("MAILJOT_TEMPLATE");
    expect(stdout).not.toContain("set -euo");
  });
});

describe("scripts/render-data.json", () => {
  it("is a valid render body for the script's default template", async () => {
    const body = JSON.parse(await readFile(renderDataFile, "utf8"));
    const res = await fetch(`${base}/v1/render/accounts/welcome`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
  });
});

describe.skipIf(!hasCurl)("scripts/render", () => {
  const receiptInput = fileURLToPath(new URL("../test/fixtures/scripts/receipt-input.json", import.meta.url));

  it("is executable", async () => {
    await expect(access(renderScript, constants.X_OK)).resolves.toBeUndefined();
  });

  it("renders the default template with the shipped body, needing no token", async () => {
    const { code, stdout, stderr } = await render([]);
    expect(code).toBe(0);
    expect(stderr).toBe(`POST ${base}/v1/render/accounts/welcome -> HTTP 200\n`);
    const result = JSON.parse(stdout); // stdout is the JSON alone, so it pipes cleanly
    expect(result).toMatchObject({ template: "accounts/welcome", version: "1.0.0", subject: "Welcome aboard, Alice!" });
    expect(result.html).toContain("Welcome aboard, Alice!");
    expect(result.text).toContain("Welcome aboard, Alice!");
    // Nothing is sent: the render response has no transport.
    expect(result).not.toHaveProperty("transport");
  });

  it("does not use or require the sender token", async () => {
    const withToken = await render([], { MAILJOT_TRANSPORT_AUTH_TOKEN: "an-unrelated-token-0123456789" });
    expect(withToken.code).toBe(0);
  });

  it("takes the template and body from options or from the environment", async () => {
    const viaOptions = await render(["-t", "billing/receipt", "-f", receiptInput]);
    expect(viaOptions.code).toBe(0);
    expect(JSON.parse(viaOptions.stdout).subject).toBe("Your receipt for order A-1");

    const viaEnv = await render([], { MAILJOT_TEMPLATE: "billing/receipt", MAILJOT_RENDER_BODY: receiptInput });
    expect(JSON.parse(viaEnv.stdout).subject).toBe("Your receipt for order A-1");
  });

  it("ignores MAILJOT_SENDER_BODY, which belongs to scripts/sender and holds a differently shaped body", async () => {
    const result = await render([], { MAILJOT_SENDER_BODY: senderDataFile });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).subject).toBe("Welcome aboard, Alice!");
  });

  it("exits 1 and still prints the response when the body does not fit the template", async () => {
    // The welcome body is wrong for a receipt; the render route answers with its standard 422.
    const mismatch = await render(["-t", "billing/receipt"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.stderr).toContain("HTTP 422");
    expect(JSON.parse(mismatch.stdout).error).toMatchObject({ code: "validation_failed" });

    // The sender's wrapped body is not a render body either.
    const wrapped = await render(["-f", senderDataFile]);
    expect(wrapped.code).toBe(1);
    expect(JSON.parse(wrapped.stdout).error.code).toBe("validation_failed");

    const unknown = await render(["-t", "accounts/nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("HTTP 404");
  });

  it("exits 2 with a clear message for usage problems, and has no transport option", async () => {
    for (const [args, message] of [
      [["-f", "/no/such/file.json"], "body file not found"],
      [["-x"], "unknown option -x"],
      [["-T", "Logging"], "unknown option -T"],
      [["-d", "accounts/welcome"], "unknown option -d"],
      [["-t"], "option -t needs a value"],
      [["stray"], "unexpected argument 'stray'"],
    ] as [string[], string][]) {
      const result = await render(args);
      expect(result.code, args.join(" ")).toBe(2);
      expect(result.stderr).toContain(message);
      expect(result.stderr.startsWith("render:")).toBe(true);
    }
  });

  it("prints its documentation with -h", async () => {
    const { code, stdout } = await render(["-h"]);
    expect(code).toBe(0);
    expect(stdout).toContain("-t TEMPLATE");
    expect(stdout).toContain("MAILJOT_TEMPLATE");
    expect(stdout).not.toContain("TRANSPORT");
    expect(stdout).not.toContain("set -euo");
  });
});
