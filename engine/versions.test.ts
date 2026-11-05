import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureLogger } from "../test/captureLogger.js";
import { assertTemplateModule } from "./template.js";
import { discoverVersions } from "./versions.js";

describe("discoverVersions", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "mailjot-ver-"));
    for (const d of ["v2", "v10", "v1", "v0", "v01", "vx", "version1", "accounts", ".hidden"]) {
      await mkdir(path.join(root, d));
    }
  });
  afterAll(() => rm(root, { recursive: true, force: true }));

  it("returns only v<N> directories, sorted numerically", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const versions = await discoverVersions(root);
    expect(versions.map((v) => v.name)).toEqual(["v1", "v2", "v10"]);
    expect(versions.map((v) => v.number)).toEqual([1, 2, 10]);
    expect(versions[0]!.dir).toBe(path.join(root, "v1"));
    warn.mockRestore();
  });

  it("warns about directories that are not versions, but not hidden ones", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await discoverVersions(root);
    const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).toContain('"accounts"');
    expect(warned).toContain('"v0"');
    expect(warned).not.toContain(".hidden");
    warn.mockRestore();
  });
});

describe("discoverVersions with a logger", () => {
  it("logs ignored directories as structured warnings instead of using the console", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "mailjot-ver-log-"));
    for (const d of ["v1", "static", "v0", ".hidden"]) await mkdir(path.join(root, d));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const captured = captureLogger();
    try {
      const versions = await discoverVersions(root, captured.logger);
      expect(versions.map((v) => v.name)).toEqual(["v1"]);

      const ignored = captured.lines().filter((l) => l.event === "mailjot.versions.ignored");
      expect(ignored.map((l) => l.directory).sort()).toEqual(["static", "v0"]);
      expect(ignored[0]).toMatchObject({ level: "warn", root });
      expect(ignored[0]!.msg).toContain("not a version directory");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("metadata.version rules", () => {
  const base = (version: string) => ({
    schema: undefined,
    metadata: { id: "a/b", version, description: "d" },
  });
  const problems = (version: string, major?: number) => {
    try {
      assertTemplateModule("a/b", base(version) as never, major);
    } catch (err) {
      return (err as { problems: string[] }).problems.filter((p) => p.includes("metadata.version"));
    }
    return [];
  };

  it("accepts semver", () => {
    expect(problems("1.0.0", 1)).toEqual([]);
    expect(problems("2.10.3-beta.1", 2)).toEqual([]);
  });

  it("rejects non-semver strings", () => {
    expect(problems("1.0")).toHaveLength(1);
    expect(problems("v1")).toHaveLength(1);
  });

  it("rejects a major that differs from the directory's", () => {
    expect(problems("2.0.0", 1)).toHaveLength(1);
    expect(problems("2.0.0")).toEqual([]);
  });
});
