import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../test/captureLogger.js";
import { createApp } from "./app.js";

// The canary: a leak in the log is caught here, whichever line or transport causes it.
//
// Every secret and every piece of private content below is distinctive, and the whole run is sent through the real
// sender, the real built-in transports (Mailjet with `fetch` stubbed) and the real startup, with the credentials in
// the environment and a provider that echoes them back in its error messages. At the end, none of them may appear
// anywhere in what was logged. If you add a log line and this fails, the line leaks: remove the field, do not
// edit the list.

const templates = fileURLToPath(new URL("../templates", import.meta.url));
const fixtureTemplates = fileURLToPath(new URL("../test/fixtures/templates", import.meta.url));
const transports = fileURLToPath(new URL("../transports", import.meta.url));

const TOKEN = "canary-bearer-token-0123456789";
const API_KEY = "canary-mj-key-AAAA1111";
const API_SECRET = "canary-mj-secret-BBBB2222";
const BASIC = Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");
const ECHO = "ECHO-7f3a-provider-text";
const HOST = "internal-host-9k2.example.invalid";
const CUSTOM_ID = "order-secret-ref-77";
const NAME = "Zyxwv Quux";

const envelope = {
  from: { email: "canary.sender@example.net", name: "Canary Sender" },
  to: [{ email: "canary.recipient@example.net", name: "Canary Recipient" }],
  cc: [{ email: "canary.cc@example.net" }],
};

/** None of these may ever appear in the log. */
const FORBIDDEN = [
  TOKEN,
  API_KEY,
  API_SECRET,
  BASIC,
  ECHO,
  HOST,
  CUSTOM_ID,
  "Zyxwv",
  "canary.sender@example.net",
  "canary.recipient@example.net",
  "canary.cc@example.net",
  "Canary Sender",
  "Canary Recipient",
  "Welcome aboard", // the subject and the text of the email
  "<!DOCTYPE",
  "<html",
  "Bearer ",
];

const logs = captureLogger({ LOG_LEVEL: "trace" });
let generated = 0;

const realFetch = globalThis.fetch;
let providerReply: () => Response | Promise<Response> = () => new Response("{}");
let appOrigin = "";

let real: Server;
let broken: Server;
let tmp: string;
let realBase = "";
let brokenBase = "";

async function start(templatesRoot: string, env: Record<string, string>): Promise<{ server: Server; base: string }> {
  const app = await createApp(templatesRoot, {
    transportsRoot: transports,
    env: { MAILJOT_TRANSPORT_AUTH_TOKEN: TOKEN, MAILJET_API_KEY: API_KEY, MAILJET_API_SECRET: API_SECRET, ...env },
    logger: logs.logger,
    generateRequestId: () => `canary-${++generated}`,
  });
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "mailjot-canary-"));
  await writeFile(path.join(tmp, "blocker"), "a file, so a recording under it cannot be written");
  ({ server: real, base: realBase } = await start(templates, { RECORDING_DIR: path.join(tmp, "blocker", "recordings") }));
  ({ server: broken, base: brokenBase } = await start(fixtureTemplates, { RECORDING_DIR: path.join(tmp, "recordings") }));
  appOrigin = "http://127.0.0.1";

  // Calls to the apps go through; anything else is the provider, and answers as scripted.
  vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    String(input).startsWith(appOrigin) ? realFetch(input, init) : Promise.resolve().then(() => providerReply()),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await Promise.all([real, broken].map((s) => new Promise((r) => s.close(r))));
  await rm(tmp, { recursive: true, force: true });
});

const post = (base: string, route: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}` }) =>
  fetch(`${base}/v1/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const mailjet = (extra: Record<string, unknown> = {}) => ({ envelope, input: { name: NAME }, options: { customId: CUSTOM_ID }, ...extra });

describe("the log never contains a secret, a recipient, a subject, a body or a provider's own words", () => {
  it("through every path that logs", async () => {
    // Delivery through Mailjet: accepted, refused (the provider echoing everything back), unauthorised, down, unreachable, not JSON.
    providerReply = () => json({ Messages: [{ Status: "success", To: [{ Email: envelope.to[0]!.email, MessageUUID: "uuid-1" }] }] });
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet())).status).toBe(200);

    providerReply = () =>
      json({ Messages: [{ Status: "error", Errors: [{ ErrorCode: "mj-0013", ErrorMessage: `${envelope.to[0]!.email} is invalid ${ECHO} key=${API_KEY} secret=${API_SECRET}` }] }] }, 400);
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet())).status).toBe(502);

    providerReply = () => json({ ErrorMessage: `${ECHO} bad credentials ${BASIC}` }, 401);
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet())).status).toBe(502);

    providerReply = () => json({ ErrorMessage: ECHO }, 503);
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet())).status).toBe(502);

    providerReply = () => {
      throw Object.assign(new TypeError(`getaddrinfo ENOTFOUND ${HOST} ${API_SECRET}`), { cause: { code: "ENOTFOUND" } });
    };
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet())).status).toBe(502);

    providerReply = () => new Response(`<html>${ECHO} ${API_SECRET}</html>`, { status: 502 });
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet())).status).toBe(502);

    // The other built-in transports, a failed recording, and a dry run.
    expect((await post(realBase, "sender/BlackHole/accounts/welcome", { envelope, input: { name: NAME } })).status).toBe(200);
    expect((await post(realBase, "sender/Recording/accounts/welcome", { envelope, input: { name: NAME }, options: { tag: CUSTOM_ID } })).status).toBe(502);
    expect((await post(brokenBase, "sender/Recording/accounts/leaky", { envelope, input: { name: NAME } })).status).toBe(400);
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet({ dryRun: true }))).status).toBe(200);

    // Render failures and bad requests, with the private values in the input and the envelope.
    expect((await post(brokenBase, "sender/BlackHole/accounts/broken", { envelope, input: { name: NAME } })).status).toBe(400);
    expect((await post(brokenBase, "sender/BlackHole/accounts/explosive", { envelope, input: { name: NAME } })).status).toBe(500);
    expect((await post(brokenBase, "render/accounts/broken", { name: NAME })).status).toBe(500);
    expect((await post(realBase, "render/accounts/welcome", { name: NAME, extra: ECHO })).status).toBe(422);
    expect((await post(realBase, "sender/BlackHole/accounts/welcome", { envelope, input: { name: 12, extra: ECHO } })).status).toBe(400);
    expect((await post(realBase, "sender/BlackHole/accounts/welcome", `{"input": "${ECHO}`)).status).toBe(400);
    expect((await post(realBase, "sender/Mailjet/accounts/welcome", mailjet({ options: { customId: CUSTOM_ID, nope: ECHO } }))).status).toBe(400);

    // Authentication: nothing, a wrong token that looks like the right one, and the right one on an unknown route.
    expect((await post(realBase, "sender/BlackHole/accounts/welcome", { envelope, input: { name: NAME } }, {})).status).toBe(401);
    expect((await post(realBase, "sender/BlackHole/accounts/welcome", { envelope, input: { name: NAME } }, { Authorization: `Bearer ${TOKEN}x` })).status).toBe(401);
    expect((await fetch(`${realBase}/v1/sender`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await post(realBase, `sender/${ECHO}/accounts/welcome`, mailjet())).status).toBe(404);
    expect((await fetch(`${realBase}/v1/${ECHO}?key=${API_KEY}`, { headers: { "X-Request-Id": `${ECHO} ${API_KEY}` } })).status).toBe(404); // an unsafe ID is replaced, never logged

    const lines = logs.raw();
    const output = lines.join("");

    // The run really did exercise the logging: guard against the test passing because nothing was logged.
    const events = new Set(logs.lines().map((l) => l.event));
    for (const event of [
      "mailjot.sender.ready",
      "mailjot.transport.status",
      "mailjot.request",
      "mailjot.send.ok",
      "mailjot.send.failed",
      "mailjot.auth.rejected",
      "mailjot.render.failed",
      "mailjot.error.unhandled",
      "mailjot.transport.mailjet.sent",
      "mailjot.transport.mailjet.rejected",
      "mailjot.transport.mailjet.unreachable",
      "mailjot.transport.mailjet.non_json",
      "mailjot.transport.blackhole.swallowed",
      "mailjot.transport.recording.write_failed",
    ]) {
      expect(events, event).toContain(event);
    }
    expect(lines.length).toBeGreaterThan(40);

    // Every line is a JSON object: nothing slipped out as free text.
    expect(lines.every((l) => /^\{.*\}\n$/.test(l))).toBe(true);

    for (const value of FORBIDDEN) expect(output, `the log contains ${JSON.stringify(value)}`).not.toContain(value);
    // Not encoded either.
    for (const value of [API_SECRET, TOKEN, envelope.to[0]!.email]) {
      expect(output, `base64 of ${value}`).not.toContain(Buffer.from(value).toString("base64"));
    }
  });
});
