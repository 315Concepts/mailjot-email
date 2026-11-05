import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (file: string) => readFile(path.join(root, file), "utf8");

/** All files under `dir` (relative to the repository root), skipping dependency and build output. */
async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(path.join(root, dir), { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((e) => e.name !== "node_modules" && e.name !== "dist")
      .map((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])),
  );
  return nested.flat();
}

describe("source tree hygiene", () => {
  it("has no compiled output beside the sources (it would shadow the TypeScript files)", async () => {
    // A build that compiles files outside its root, or the wrong exclude list, can drop `.js` files
    // next to their `.ts` sources, where `./render.js` then resolves to the stale copy.
    const stray = [];
    for (const dir of ["engine", "storybook", "templates", "transports", "scripts", "test", ".storybook"]) {
      stray.push(...(await walk(dir)).filter((f) => /\.(js|js\.map|d\.ts|tsbuildinfo)$/.test(f)));
    }
    expect(stray).toEqual([]);
  });

  it("keeps stories and tests out of the compiled templates", async () => {
    const config = JSON.parse(await read("tsconfig.templates.json")) as { include: string[]; exclude: string[] };
    // The exclude patterns must live under the directories that are included, or they exclude nothing.
    for (const pattern of config.exclude) {
      expect(config.include.some((dir) => pattern.startsWith(`${dir}/`)), `exclude "${pattern}" is outside ${config.include}`).toBe(true);
    }
    expect(config.exclude.join(" ")).toMatch(/stories/);
    expect(config.exclude.join(" ")).toMatch(/test/);
  });
});
