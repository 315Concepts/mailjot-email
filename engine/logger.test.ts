import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger, findPackageVersion, parseLogLevel, redact, REDACTED, serializeError } from "./logger.js";

/** A logger whose output is captured instead of written to stdout. */
function capture(env: Record<string, string | undefined> = {}) {
  const raw: string[] = [];
  const logger = createLogger({ env, destination: { write: (line: string) => void raw.push(line) } });
  return { logger, raw, lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

describe("log level", () => {
  it("defaults to info when LOG_LEVEL is unset or empty", () => {
    for (const env of [{}, { LOG_LEVEL: "" }, { LOG_LEVEL: "  " }]) {
      const { logger, lines } = capture(env);
      logger.debug("hidden");
      logger.info("shown");
      expect(lines().map((l) => l.msg)).toEqual(["shown"]);
    }
  });

  it("filters below the configured level, ignoring case and whitespace", () => {
    const { logger, lines } = capture({ LOG_LEVEL: " WARN " });
    logger.info("hidden");
    logger.warn("shown");
    logger.error("shown too");
    expect(lines().map((l) => l.msg)).toEqual(["shown", "shown too"]);
  });

  it("supports debug and silent", () => {
    const debug = capture({ LOG_LEVEL: "debug" });
    debug.logger.debug("d");
    expect(debug.lines()).toHaveLength(1);

    const silent = capture({ LOG_LEVEL: "silent" });
    silent.logger.fatal("nothing");
    expect(silent.raw).toEqual([]);
  });

  it("falls back to info for an unknown level and says so once", () => {
    const { logger, lines } = capture({ LOG_LEVEL: "loud" });
    logger.info("after");
    const [first, second] = lines();
    expect(first).toMatchObject({ level: "warn", event: "mailjot.log.level_invalid", requested: "loud", using: "info" });
    expect(second).toMatchObject({ level: "info", msg: "after" });
    expect(lines()).toHaveLength(2);
  });

  it("parses levels", () => {
    expect(parseLogLevel(undefined)).toEqual({ level: "info" });
    expect(parseLogLevel("Trace")).toEqual({ level: "trace" });
    expect(parseLogLevel("verbose")).toEqual({ level: "info", invalid: "verbose" });
  });
});

describe("line format", () => {
  it("writes one JSON object per line with a level label, ISO time, service and version", () => {
    const { logger, raw, lines } = capture();
    logger.info({ event: "mailjot.test", n: 1 }, "hello");
    expect(raw).toHaveLength(1);
    expect(raw[0]!.endsWith("\n")).toBe(true);
    const [line] = lines();
    expect(line).toMatchObject({ level: "info", service: "mailjot", event: "mailjot.test", n: 1, msg: "hello" });
    expect(line!.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(new Date(line!.time as string).toISOString()).toBe(line!.time);
    expect(line).not.toHaveProperty("pid");
    expect(line).not.toHaveProperty("hostname");
  });

  it("keeps a hostile message on a single line", () => {
    const { logger, raw } = capture();
    logger.info({ note: 'a\n{"level":"error","msg":"forged"}' }, "line1\nline2");
    expect(raw).toHaveLength(1);
    expect(raw[0]!.trimEnd().includes("\n")).toBe(false);
  });
});

describe("redaction", () => {
  const secrets = {
    authorization: "Bearer tok-1234567890abcdef",
    cookie: "session=abc",
    MAILJET_API_KEY: "key-value",
    MAILJET_API_SECRET: "secret-value",
    MAILJOT_TRANSPORT_AUTH_TOKEN: "token-value",
    password: "hunter2",
  };

  it("redacts secret-named keys at any depth, in objects and arrays", () => {
    const { logger, raw, lines } = capture();
    logger.info({ req: { headers: { ...secrets, accept: "application/json" } }, list: [{ token: "t-1" }, { fine: 1 }], env: secrets }, "x");

    for (const value of ["tok-1234567890abcdef", "session=abc", "key-value", "secret-value", "token-value", "hunter2", "t-1"]) {
      expect(raw.join("")).not.toContain(value);
    }
    const line = lines()[0] as { req: { headers: Record<string, string> }; list: unknown[] };
    expect(line.req.headers.authorization).toBe(REDACTED);
    expect(line.req.headers.MAILJET_API_SECRET).toBe(REDACTED);
    expect(line.req.headers.accept).toBe("application/json");
    expect(line.list).toEqual([{ token: REDACTED }, { fine: 1 }]);
  });

  it("does not modify the object it was given", () => {
    const input = { headers: { authorization: "Bearer x" }, nested: [{ token: "t" }] };
    const copy = structuredClone(input);
    redact(input);
    expect(input).toEqual(copy);
  });

  it("survives cycles and very deep objects", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    expect(redact(cyclic)).toEqual({ name: "a", self: "[Circular]" });

    let deep: Record<string, unknown> = { token: "t" };
    for (let i = 0; i < 50; i++) deep = { next: deep };
    expect(() => JSON.stringify(redact(deep))).not.toThrow();
    expect(JSON.stringify(redact(deep))).not.toContain('"t"');
  });

  it("leaves a shared (non-cyclic) object visible in both places", () => {
    const shared = { a: 1 };
    expect(redact({ x: shared, y: shared })).toEqual({ x: { a: 1 }, y: { a: 1 } });
  });

  it("leaves non-secret values and non-plain values alone", () => {
    const date = new Date(0);
    expect(redact({ n: 1, s: "x", d: date, nil: null })).toEqual({ n: 1, s: "x", d: date, nil: null });
  });
});

describe("error serialization", () => {
  it("logs the type, message, code and stack of an error under `err`", () => {
    const { logger, lines } = capture();
    const error = Object.assign(new TypeError("bad input"), { code: "ERR_BAD" });
    logger.error({ err: error }, "failed");
    const err = (lines()[0] as { err: Record<string, unknown> }).err;
    expect(err).toMatchObject({ type: "TypeError", message: "bad input", code: "ERR_BAD" });
    expect(String(err.stack)).toContain("bad input");
  });

  it("follows the cause chain by type, message and stack only", () => {
    const root = Object.assign(new Error("provider said no"), { response: { body: "SECRET-PROVIDER-BODY" }, request: { to: "alice@example.com" } });
    const top = new Error("send failed", { cause: root });
    const { logger, raw, lines } = capture();
    logger.error({ err: top }, "failed");

    const err = (lines()[0] as { err: { cause: Record<string, unknown> } }).err;
    expect(err.cause).toMatchObject({ type: "Error", message: "provider said no" });
    expect(Object.keys(err.cause).sort()).toEqual(["message", "stack", "type"]);
    expect(raw.join("")).not.toContain("SECRET-PROVIDER-BODY");
    expect(raw.join("")).not.toContain("alice@example.com");
  });

  it("describes a non-Error cause by its type, not its contents", () => {
    const serialized = serializeError(new Error("outer", { cause: { body: "SECRET-BODY" } }));
    expect(serialized.cause).toEqual({ type: "object", message: "(non-Error value of type object)" });
    expect(JSON.stringify(serialized)).not.toContain("SECRET-BODY");
  });

  it("keeps a thrown string and describes other thrown values by type", () => {
    expect(serializeError("boom")).toEqual({ type: "string", message: "boom" });
    expect(serializeError(42).message).toBe("(non-Error value of type number)");
    expect(serializeError(null).message).toBe("(non-Error value of type null)");
    expect(serializeError({ secret: "x" }).message).not.toContain("x\"");
  });

  it("stops at a bounded number of causes", () => {
    let error = new Error("0");
    for (let i = 1; i < 20; i++) error = new Error(String(i), { cause: error });
    let depth = 0;
    for (let s: ReturnType<typeof serializeError> | undefined = serializeError(error); s; s = s.cause) depth++;
    expect(depth).toBeLessThanOrEqual(6);
  });

  it("serializes an error that has no stack", () => {
    const error = new Error("no stack");
    delete error.stack;
    expect(serializeError(error)).toEqual({ type: "Error", message: "no stack" });
  });

  it("ignores a non-string, non-number code", () => {
    expect(serializeError(Object.assign(new Error("x"), { code: { nested: true } }))).not.toHaveProperty("code");
  });
});

describe("package version lookup", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mailjot-version-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const dir = (...parts: string[]) => {
    const d = path.join(root, ...parts);
    mkdirSync(d, { recursive: true });
    return d;
  };
  const pkg = (where: string, contents: string) => writeFileSync(path.join(where, "package.json"), contents);

  it("finds the version in the repository's own package.json from the source and compiled depths", () => {
    expect(findPackageVersion(import.meta.dirname)).toMatch(/^\d+\.\d+\.\d+/);
    expect(findPackageVersion(path.join(import.meta.dirname, "..", "dist", "engine"))).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("walks up to the package.json named mailjot, at most four levels", () => {
    const top = dir("found");
    pkg(top, '{"name":"mailjot","version":"9.8.7"}');
    expect(findPackageVersion(dir("found", "a", "b"))).toBe("9.8.7");
    expect(findPackageVersion(dir("found", "a", "b", "c", "d"))).toBe("unknown"); // five levels down is out of reach
  });

  it("ignores another package's package.json and keeps looking", () => {
    const top = dir("outer");
    pkg(top, '{"name":"mailjot","version":"1.2.3"}');
    const inner = dir("outer", "node_modules", "other");
    pkg(inner, '{"name":"other","version":"5.5.5"}');
    expect(findPackageVersion(inner)).toBe("1.2.3");
  });

  it("is unknown when there is no usable package.json: absent, unreadable JSON, or no version", () => {
    expect(findPackageVersion(dir("empty"))).toBe("unknown");
    const broken = dir("broken");
    pkg(broken, "{ not json");
    expect(findPackageVersion(broken)).toBe("unknown");
    const noVersion = dir("noversion");
    pkg(noVersion, '{"name":"mailjot"}');
    expect(findPackageVersion(noVersion)).toBe("unknown");
  });
});
