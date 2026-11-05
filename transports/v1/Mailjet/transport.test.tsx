import { afterEach, describe, expect, it, vi } from "vitest";
import { createV1TransportLoader } from "../../../engine/routers/v1/transport.js";
import { TransportUnavailableError } from "../../../engine/transport.js";
import { toMailjetRequest } from "./transport.js";
import { captureLogger } from "../../../test/captureLogger.js";

const transportsRoot = new URL("..", import.meta.url).pathname;
const env = { MAILJET_API_KEY: "key", MAILJET_API_SECRET: "secret" };

/** Where the transport's log lines go in these tests (all levels, so debug lines are visible). */
const logs = captureLogger({ LOG_LEVEL: "debug" });

const message = {
  template: "billing/receipt",
  version: "1.0.0",
  subject: "Your receipt",
  html: "<p>Receipt</p>",
  text: "Receipt",
  envelope: {
    from: { email: "billing@example.com", name: "Billing" },
    to: [{ email: "alice@example.com", name: "Alice" }, { email: "bob@example.com" }],
  },
  options: {},
  logger: logs.logger,
};

const loadMailjet = (overrides: Record<string, string | undefined> = {}) =>
  createV1TransportLoader(transportsRoot, { env: { ...env, ...overrides } }).load("mailjet");

const stubFetch = (response: Response | Error) => {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("Mailjet configuration", () => {
  it("is unavailable without credentials", async () => {
    const loader = createV1TransportLoader(transportsRoot, { env: {} });
    const err = await loader.load("Mailjet").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportUnavailableError);
    const problems = (err as TransportUnavailableError).problems.join();
    expect(problems).toContain("MAILJET_API_KEY");
    expect(problems).toContain("MAILJET_API_SECRET");
  });

  it("is available with credentials, using the default API URL", async () => {
    const mailjet = await loadMailjet();
    expect(mailjet.name).toBe("Mailjet");
    expect(mailjet.optionsSchema.safeParse({ sandbox: true, customId: "order-1" }).success).toBe(true);
    expect(mailjet.optionsSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });
});

describe("request mapping (generic message to Mailjet Send API v3.1)", () => {
  const map = (m: Record<string, unknown>) =>
    toMailjetRequest({ ...message, ...m, config: { ...env, MAILJET_API_URL: "https://api.mailjet.com" } } as never);

  it("maps sender, recipients, subject and both bodies", () => {
    expect(map({})).toEqual({
      Messages: [
        {
          From: { Email: "billing@example.com", Name: "Billing" },
          To: [{ Email: "alice@example.com", Name: "Alice" }, { Email: "bob@example.com" }],
          Subject: "Your receipt",
          TextPart: "Receipt",
          HTMLPart: "<p>Receipt</p>",
        },
      ],
    });
  });

  it("maps cc, bcc, reply-to and the provider options", () => {
    const body = map({
      envelope: { ...message.envelope, cc: [{ email: "c@example.com" }], bcc: [{ email: "d@example.com" }], replyTo: { email: "r@example.com", name: "R" } },
      options: { sandbox: true, customId: "order-1" },
    });
    expect(body).toMatchObject({
      SandboxMode: true,
      Messages: [{ Cc: [{ Email: "c@example.com" }], Bcc: [{ Email: "d@example.com" }], ReplyTo: { Email: "r@example.com", Name: "R" }, CustomID: "order-1" }],
    });
  });
});

describe("sending", () => {
  it("posts to the Send API with basic auth and returns the message id and raw response", async () => {
    const body = { Messages: [{ Status: "success", To: [{ Email: "alice@example.com", MessageUUID: "uuid-1", MessageID: 123 }] }] };
    const fetchMock = stubFetch(json(body));

    const result = await (await loadMailjet()).send(message);

    expect(result).toEqual({ ok: true, messageId: "uuid-1", response: body });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe("https://api.mailjet.com/v3.1/send");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("key:secret").toString("base64")}`);
    expect(JSON.parse(init.body as string).Messages[0].Subject).toBe("Your receipt");
  });

  it("honours MAILJET_API_URL", async () => {
    const fetchMock = stubFetch(json({ Messages: [{ Status: "success", To: [{ MessageID: 7 }] }] }));
    const result = await (await loadMailjet({ MAILJET_API_URL: "https://proxy.example.com" })).send(message);
    expect(String((fetchMock.mock.calls[0] as unknown as [URL])[0])).toBe("https://proxy.example.com/v3.1/send");
    expect(result).toMatchObject({ ok: true, messageId: "7" });
  });

  it("maps a per-message error to a rejection with Mailjet's reason", async () => {
    const body = { Messages: [{ Status: "error", Errors: [{ ErrorCode: "mj-0013", ErrorMessage: "Invalid email address" }] }] };
    stubFetch(json(body, 400));
    expect(await (await loadMailjet()).send(message)).toEqual({
      ok: false,
      reason: "rejected",
      message: "Mailjet rejected the message: Invalid email address",
      response: body,
    });
  });

  it("maps an authentication failure to a rejection", async () => {
    stubFetch(json({ ErrorMessage: "API key authentication/authorization failure" }, 401));
    expect(await (await loadMailjet()).send(message)).toMatchObject({
      ok: false,
      reason: "rejected",
      message: expect.stringContaining("authentication/authorization failure"),
    });
  });

  it("treats a 200 whose message status is not success as a rejection", async () => {
    stubFetch(json({ Messages: [{ Status: "error", Errors: [{ ErrorMessage: "Sender not allowed" }] }] }));
    expect(await (await loadMailjet()).send(message)).toMatchObject({ ok: false, reason: "rejected" });
  });

  it("treats Mailjet 5xx as unreachable", async () => {
    stubFetch(json({ ErrorMessage: "Internal error" }, 503));
    expect(await (await loadMailjet()).send(message)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("treats a non-JSON response as unreachable", async () => {
    stubFetch(new Response("<html>Bad gateway</html>", { status: 502 }));
    expect(await (await loadMailjet()).send(message)).toMatchObject({ ok: false, reason: "unreachable" });
  });

  it("treats a network failure as unreachable, without leaking details", async () => {
    stubFetch(new TypeError("getaddrinfo ENOTFOUND api.mailjet.com secret-host"));
    const result = await (await loadMailjet()).send(message);
    expect(result).toMatchObject({ ok: false, reason: "unreachable" });
    expect(JSON.stringify(result)).not.toContain("secret-host");
  });

  it("never includes the credentials in a result", async () => {
    stubFetch(json({ ErrorMessage: "nope" }, 401));
    expect(JSON.stringify(await (await loadMailjet()).send(message))).not.toMatch(/secret|a2V5OnNlY3JldA/);
  });
});

describe("logging", () => {
  const events = (name: string) => logs.lines().filter((l) => l.event === name);
  const everything = () => logs.raw().join("");

  it("notes an accepted message at debug, with the HTTP status and how long it took", async () => {
    logs.reset();
    stubFetch(json({ Messages: [{ Status: "success", To: [{ MessageUUID: "uuid-1" }] }] }));
    await (await loadMailjet()).send(message);

    expect(events("mailjot.transport.mailjet.sent")).toEqual([
      expect.objectContaining({ level: "debug", http_status: 200, duration_ms: expect.any(Number) }),
    ]);
  });

  it("logs a rejection with the status and Mailjet's error codes, but not its text, the response or the recipient", async () => {
    logs.reset();
    stubFetch(json({ Messages: [{ Status: "error", Errors: [{ ErrorCode: "mj-0013", ErrorMessage: "alice@example.com is an invalid email address" }] }] }, 400));
    const result = await (await loadMailjet()).send(message);

    expect(result).toMatchObject({ ok: false, reason: "rejected", message: expect.stringContaining("alice@example.com") }); // the caller gets the text
    expect(events("mailjot.transport.mailjet.rejected")).toEqual([
      expect.objectContaining({ level: "warn", http_status: 400, error_codes: ["mj-0013"], duration_ms: expect.any(Number) }),
    ]);
    expect(events("mailjot.transport.mailjet.sent")).toEqual([]);
    for (const value of ["alice@example.com", "invalid email address", "bob@example.com", "Receipt", "Your receipt"]) expect(everything(), value).not.toContain(value);
  });

  it("logs an authentication failure without the credentials or the provider's wording", async () => {
    logs.reset();
    stubFetch(json({ ErrorMessage: "API key authentication/authorization failure" }, 401));
    await (await loadMailjet()).send(message);

    expect(events("mailjot.transport.mailjet.rejected")).toEqual([expect.objectContaining({ http_status: 401 })]);
    expect(events("mailjot.transport.mailjet.rejected")[0]).not.toHaveProperty("error_codes");
    for (const value of ["secret", "a2V5OnNlY3JldA", "authentication/authorization"]) expect(everything(), value).not.toContain(value);
  });

  it("logs that Mailjet could not be reached, by kind only, never the error text (which can name the host)", async () => {
    logs.reset();
    stubFetch(Object.assign(new TypeError("getaddrinfo ENOTFOUND api.mailjet.com secret-host"), { cause: { code: "ENOTFOUND" } }));
    await (await loadMailjet()).send(message);

    expect(events("mailjot.transport.mailjet.unreachable")).toEqual([
      expect.objectContaining({ level: "warn", error: "TypeError", code: "ENOTFOUND", duration_ms: expect.any(Number) }),
    ]);
    for (const value of ["secret-host", "api.mailjet.com", "getaddrinfo"]) expect(everything(), value).not.toContain(value);
  });

  it("copes with something other than an Error being thrown, and logs only the kind", async () => {
    logs.reset();
    vi.stubGlobal("fetch", () => Promise.reject("boom: secret-host"));
    const result = await (await loadMailjet()).send(message);

    expect(result).toEqual({ ok: false, reason: "unreachable", message: "Mailjet request failed: error" });
    expect(events("mailjot.transport.mailjet.unreachable")).toEqual([expect.objectContaining({ error: "error" })]);
    expect(events("mailjot.transport.mailjet.unreachable")[0]).not.toHaveProperty("code");
    expect(everything()).not.toContain("secret-host");
  });

  it("leaves out a failure code that is not a string", async () => {
    logs.reset();
    stubFetch(Object.assign(new TypeError("x"), { cause: { code: 99 } }));
    await (await loadMailjet()).send(message);
    expect(events("mailjot.transport.mailjet.unreachable")[0]).not.toHaveProperty("code");
  });

  it("logs a rejection that carries no error codes without an error_codes field", async () => {
    logs.reset();
    stubFetch(json({ Messages: [{ Status: "error", Errors: [{ ErrorMessage: "Sender not allowed" }, { ErrorCode: 7 }] }] }, 400));
    await (await loadMailjet()).send(message);

    const [line] = events("mailjot.transport.mailjet.rejected");
    expect(line).toMatchObject({ level: "warn", http_status: 400 });
    expect(line).not.toHaveProperty("error_codes");
    expect(everything()).not.toContain("Sender not allowed");
  });

  it("logs every error code when a message has several", async () => {
    logs.reset();
    stubFetch(json({ Messages: [{ Status: "error", Errors: [{ ErrorCode: "mj-0001" }, { ErrorCode: "mj-0002" }] }, { Status: "error", Errors: [{ ErrorCode: "mj-0003" }] }] }, 400));
    await (await loadMailjet()).send(message);
    expect(events("mailjot.transport.mailjet.rejected")[0]).toMatchObject({ error_codes: ["mj-0001", "mj-0002", "mj-0003"] });
  });

  it("logs a rejection whose message has no Errors at all, without error codes", async () => {
    logs.reset();
    stubFetch(json({ Messages: [{ Status: "error" }] }, 400));
    expect(await (await loadMailjet()).send(message)).toMatchObject({ ok: false, reason: "rejected" });
    expect(events("mailjot.transport.mailjet.rejected")[0]).not.toHaveProperty("error_codes");
  });

  it("accepts a success that names no recipient, with no message id", async () => {
    logs.reset();
    stubFetch(json({ Messages: [{ Status: "success" }] }));
    const result = await (await loadMailjet()).send(message);

    expect(result).toMatchObject({ ok: true, messageId: undefined });
    expect(events("mailjot.transport.mailjet.sent")).toHaveLength(1);
  });

  it("logs a non-JSON answer with its status", async () => {
    logs.reset();
    stubFetch(new Response("<html>Bad gateway</html>", { status: 502 }));
    await (await loadMailjet()).send(message);

    expect(events("mailjot.transport.mailjet.non_json")).toEqual([expect.objectContaining({ level: "warn", http_status: 502 })]);
    expect(everything()).not.toContain("Bad gateway");
  });
});
