import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("./index.ts", import.meta.url));
const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

describe("engine startup", () => {
  it("exits with a clear message when TEMPLATES_DIR is missing", () => {
    const res = spawnSync(tsx, [entry], {
      env: { ...process.env, TEMPLATES_DIR: "/nonexistent/mailjot-docs", PORT: "3004" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(res.status).toBe(1);
    // One structured line on stdout, written before the process exits.
    const lines = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: "fatal",
      service: "mailjot",
      event: "mailjot.startup.failed",
      reason: "templates_dir_unreadable",
      templates_dir: "/nonexistent/mailjot-docs",
    });
    expect(lines[0]!.msg).toContain("TEMPLATES_DIR");
  });

  it("reports an invalid layout as a structured fatal line without a stack", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mailjot-startup-"));
    try {
      mkdirSync(path.join(dir, "accounts"));
      const res = spawnSync(tsx, [entry], {
        env: { ...process.env, TEMPLATES_DIR: dir, TRANSPORTS_DIR: path.join(dir, "none"), PORT: "3005" },
        encoding: "utf8",
        timeout: 20_000,
      });
      expect(res.status).toBe(1);
      const fatal = res.stdout.trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.level === "fatal");
      expect(fatal).toMatchObject({ event: "mailjot.startup.failed", reason: "invalid_layout" });
      expect(fatal!.msg).toContain("No version directories");
      expect(fatal).not.toHaveProperty("err");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("logs a structured line when it starts listening", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mailjot-listen-"));
    mkdirSync(path.join(dir, "v1"));
    const child = spawn(tsx, [entry], { env: { ...process.env, TEMPLATES_DIR: dir, TRANSPORTS_DIR: path.join(dir, "none"), PORT: "3006", LOG_LEVEL: "info" } });
    try {
      let out = "";
      const line = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no listening line; output so far: ${out}`)), 15_000);
        child.stdout.on("data", (chunk: Buffer) => {
          out += chunk.toString();
          const found = out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.event === "mailjot.listening");
          if (found) {
            clearTimeout(timer);
            resolve(found);
          }
        });
      });
      expect(line).toMatchObject({ level: "info", port: 3006, templates_dir: dir });
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Starts the engine on `port` with `LOG_LEVEL`, waits until it answers, and returns everything it logged so far. */
  async function logsAt(level: string, port: number): Promise<Record<string, unknown>[]> {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mailjot-level-"));
    mkdirSync(path.join(dir, "v1"));
    const child = spawn(tsx, [entry], { env: { ...process.env, TEMPLATES_DIR: dir, TRANSPORTS_DIR: path.join(dir, "none"), PORT: String(port), LOG_LEVEL: level } });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => void (out += chunk.toString()));
    try {
      const deadline = Date.now() + 15_000;
      for (;;) {
        const up = await fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false);
        if (up) break;
        if (Date.now() > deadline) throw new Error(`engine did not start; output so far: ${out}`);
        await new Promise((r) => setTimeout(r, 100));
      }
      await new Promise((r) => setTimeout(r, 100)); // the health check's own log line is written as its response ends
      return out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    } finally {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("LOG_LEVEL=warn silences the startup and access lines of a healthy engine", async () => {
    expect(await logsAt("warn", 3007)).toEqual([]);
  });

  it("LOG_LEVEL=debug adds the health check, which is otherwise never logged", async () => {
    const lines = await logsAt("debug", 3008);
    expect(lines).toContainEqual(expect.objectContaining({ level: "info", event: "mailjot.listening", port: 3008 }));
    expect(lines).toContainEqual(expect.objectContaining({ level: "debug", event: "mailjot.request", route: "/healthz", status: 200 }));
  });

  it("the default level logs startup but not the health check", async () => {
    const lines = await logsAt("info", 3009);
    expect(lines.map((l) => l.event)).toEqual(["mailjot.listening"]);
  });
});
