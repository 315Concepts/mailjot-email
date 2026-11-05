import * as fsp from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Wrap writeFile so one test can make a single write fail part-way through a recording.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
import { createV1TransportLoader } from "../../../engine/routers/v1/transport.js";
import { TransportUnavailableError } from "../../../engine/transport.js";
import { captureLogger } from "../../../test/captureLogger.js";

const transportsRoot = new URL("..", import.meta.url).pathname;

/** Where the transport's log lines go in these tests. */
const logs = captureLogger();

const message = {
  template: "accounts/welcome",
  version: "1.0.0",
  subject: "Welcome aboard, Alice!",
  html: "<!DOCTYPE html><p>Welcome aboard, Alice!</p>",
  text: "Welcome aboard, Alice!",
  envelope: { from: { email: "hi@example.com", name: "Hi" }, to: [{ email: "alice@example.com" }] },
  options: {},
  logger: logs.logger,
};

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "mailjot-recording-"));
});
afterAll(() => rm(tmp, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

const load = (dir: string | undefined) =>
  createV1TransportLoader(transportsRoot, { env: dir === undefined ? {} : { RECORDING_DIR: dir } }).load("recording");

let counter = 0;
const freshDir = () => path.join(tmp, `run-${counter++}`);

describe("Recording transport configuration", () => {
  it("is unavailable without RECORDING_DIR, naming the variable", async () => {
    const err = await load(undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportUnavailableError);
    expect((err as TransportUnavailableError).problems.join()).toContain("RECORDING_DIR");
    await expect(load("")).rejects.toBeInstanceOf(TransportUnavailableError);
  });

  it("accepts a tag option and nothing else", async () => {
    const { optionsSchema } = await load(freshDir());
    expect(optionsSchema.safeParse({}).success).toBe(true);
    expect(optionsSchema.safeParse({ tag: "run-1" }).success).toBe(true);
    expect(optionsSchema.safeParse({ tag: "" }).success).toBe(false);
    expect(optionsSchema.safeParse({ other: 1 }).success).toBe(false);
  });
});

describe("Recording transport", () => {
  it("saves the message, creating the directory if needed", async () => {
    const dir = path.join(freshDir(), "nested", "recordings");
    const result = await (await load(dir)).send(message);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.messageId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f]{8}$/);
    expect(result.response).toEqual({ recorded: result.messageId, files: ["message.json", "message.html", "message.txt"] });

    const saved = path.join(dir, result.messageId!);
    expect((await readdir(saved)).sort()).toEqual(["message.html", "message.json", "message.txt"]);
    expect(await readFile(path.join(saved, "message.html"), "utf8")).toBe(message.html);
    expect(await readFile(path.join(saved, "message.txt"), "utf8")).toBe(message.text);

    const meta = JSON.parse(await readFile(path.join(saved, "message.json"), "utf8"));
    expect(meta).toMatchObject({
      id: result.messageId,
      template: "accounts/welcome",
      version: "1.0.0",
      subject: "Welcome aboard, Alice!",
      envelope: message.envelope,
      files: ["message.json", "message.html", "message.txt"],
    });
    expect(new Date(meta.recordedAt).toISOString()).toBe(meta.recordedAt);
    expect(meta).not.toHaveProperty("tag");
  });

  it("store-stgs the tag, and gives every message its own directory", async () => {
    const dir = freshDir();
    const transport = await load(dir);
    const [a, b] = await Promise.all([transport.send({ ...message, options: { tag: "run-7" } }), transport.send(message)]);
    if (!a.ok || !b.ok) throw new Error("expected both sends to succeed");

    expect(a.messageId).not.toBe(b.messageId);
    expect((await readdir(dir)).sort()).toEqual([a.messageId, b.messageId].sort());
    expect(JSON.parse(await readFile(path.join(dir, a.messageId!, "message.json"), "utf8")).tag).toBe("run-7");
  });

  it("leaves no temporary directories behind", async () => {
    const dir = freshDir();
    await (await load(dir)).send(message);
    expect((await readdir(dir)).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("cannot be steered outside its directory by anything in the request", async () => {
    const dir = freshDir();
    const hostile = "../../escape";
    const result = await (await load(dir)).send({
      ...message,
      subject: hostile,
      template: hostile,
      options: { tag: hostile },
      envelope: { from: { email: "a@example.com", name: hostile }, to: [{ email: "b@example.com" }] },
    });
    expect(result.ok).toBe(true);
    // Everything stays inside RECORDING_DIR: the only entry is the generated directory.
    expect(await readdir(dir)).toHaveLength(1);
    expect(await readdir(path.dirname(dir))).not.toContain("escape");
  });

  it("reports an unwritable location as a failure, without leaking the path", async () => {
    logs.reset();
    const blocker = path.join(tmp, "a-file");
    await writeFile(blocker, "not a directory");
    const result = await (await load(path.join(blocker, "recordings"))).send(message);

    expect(result).toEqual({ ok: false, reason: "unreachable", message: "Could not write the recording" });
    expect(JSON.stringify(result)).not.toContain(tmp);
    // The operator still gets the real cause in the log.
    expect(logs.lines()).toEqual([
      expect.objectContaining({
        level: "error",
        event: "mailjot.transport.recording.write_failed",
        directory: path.join(blocker, "recordings"),
        err: expect.objectContaining({ type: "Error", code: expect.any(String) }),
      }),
    ]);
    // What was being recorded stays out of the log.
    expect(logs.raw().join("")).not.toContain("alice@example.com");
    expect(logs.raw().join("")).not.toContain("Welcome aboard");
  });

  it("leaves nothing behind when a write fails part-way through", async () => {
    logs.reset();
    const real = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).writeFile;
    vi.mocked(fsp.writeFile).mockImplementation(async (file, data, options) => {
      if (String(file).endsWith("message.html")) throw new Error("disk full");
      return real(file, data, options as never);
    });
    try {
      const dir = freshDir();
      const result = await (await load(dir)).send(message);

      expect(result).toEqual({ ok: false, reason: "unreachable", message: "Could not write the recording" });
      expect(logs.lines()).toContainEqual(expect.objectContaining({ event: "mailjot.transport.recording.write_failed", err: expect.objectContaining({ message: "disk full" }) }));
      // No finished recording and no leftover temporary directory: a reader never sees a partial one.
      expect(await readdir(dir)).toEqual([]);
    } finally {
      vi.mocked(fsp.writeFile).mockImplementation(real as never);
    }
  });
});
