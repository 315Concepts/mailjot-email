import { afterEach, describe, expect, it, vi } from "vitest";
import { createV1TransportLoader } from "../../../engine/routers/v1/transport.js";
import { captureLogger } from "../../../test/captureLogger.js";

const transportsRoot = new URL("..", import.meta.url).pathname;

/** Where the transport's log lines go in these tests. */
const logs = captureLogger();

const base = {
  template: "accounts/welcome",
  version: "1.0.0",
  subject: "Welcome aboard, Alice!",
  html: "<p>Hi</p>",
  text: "Hi",
  envelope: { from: { email: "hi@example.com" }, to: [{ email: "alice@example.com" }] },
  options: {},
  logger: logs.logger,
};

const load = () => createV1TransportLoader(transportsRoot, { env: {} }).load("blackhole");

/** Sends one message and returns the result and the text of every line it logged. */
async function swallow(overrides: Partial<typeof base> = {}) {
  logs.reset();
  const result = await (await load()).send({ ...base, ...overrides });
  return { result, lines: logs.lines().map((l) => l.msg) };
}

afterEach(() => vi.restoreAllMocks());

describe("BlackHole configuration", () => {
  it("needs no configuration and is found regardless of case", async () => {
    const transport = await load();
    expect(transport.name).toBe("BlackHole");
    expect(transport.description).toContain("Swallows");
  });

  it("takes no options", async () => {
    const { optionsSchema } = await load();
    expect(optionsSchema.safeParse({}).success).toBe(true);
    expect(optionsSchema.safeParse({ anything: 1 }).success).toBe(false);
  });
});

describe("BlackHole", () => {
  it("logs exactly one line in the agreed format, every time", async () => {
    const { lines } = await swallow();
    // "<p>Hi</p>" is 9 characters on 1 line, "Hi" is 2 characters on 1 line.
    expect(lines).toEqual(["Swallowed 11 characters on 2 lines!"]);

    logs.reset();
    const transport = await load();
    await transport.send(base);
    await transport.send(base);
    await transport.send(base);
    expect(logs.lines().map((l) => l.msg)).toEqual(Array(3).fill("Swallowed 11 characters on 2 lines!"));
  });

  it("logs the counts as a structured event at info", async () => {
    await swallow();
    expect(logs.lines()).toEqual([
      expect.objectContaining({ level: "info", event: "mailjot.transport.blackhole.swallowed", characters: 11, lines: 2, msg: "Swallowed 11 characters on 2 lines!" }),
    ]);
  });

  it("counts the HTML and the plaintext together", async () => {
    const { lines } = await swallow({ html: "a\nbb\nccc", text: "dddd\neeeee" });
    // 8 + 10 characters (newlines count as characters), 3 + 2 lines.
    expect(lines).toEqual(["Swallowed 18 characters on 5 lines!"]);
  });

  it.each([
    ["an empty body has no lines", { html: "", text: "" }, "Swallowed 0 characters on 0 lines!"],
    ["a trailing newline does not start another line", { html: "a\n", text: "b\n\n" }, "Swallowed 5 characters on 3 lines!"],
    ["blank lines in the middle count", { html: "a\n\nb", text: "" }, "Swallowed 4 characters on 3 lines!"],
    ["CRLF and CR are one line break each", { html: "a\r\nb\rc", text: "" }, "Swallowed 6 characters on 3 lines!"],
    ["characters are code points, not UTF-16 units", { html: "😀é", text: "" }, "Swallowed 2 characters on 1 lines!"],
  ])("%s", async (_label, overrides, expected) => {
    expect((await swallow(overrides)).lines).toEqual([expected]);
  });

  it("reports success and what it swallowed, and delivers nothing", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const { result } = await swallow();
      expect(result).toEqual({ ok: true, response: { swallowed: true, characters: 11, lines: 2 } });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("never logs message content, only the counts", async () => {
    const { lines } = await swallow({ html: "<p>secret@example.com</p>", text: "secret@example.com", subject: "secret subject" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^Swallowed \d+ characters on \d+ lines!$/);
    expect(lines[0]).not.toContain("secret");
    expect(logs.raw().join("")).not.toContain("secret");
  });
});
